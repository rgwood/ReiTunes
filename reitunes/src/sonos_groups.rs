//! Keeps ReiTunes's Sonos target in step with how the speakers are really
//! grouped, and puts the saved preferred group back together on request.
//!
//! Sonos regroups speakers on its own (firmware updates, Wi-Fi drops), and a
//! group's ID embeds its coordinator's player ID, so it changes whenever the
//! coordinator does. A group ID saved when the user picked a group goes stale.

use std::{collections::HashSet, time::Duration};

use anyhow::{bail, Result};
use axum::{extract::State, http::StatusCode, Json};
use serde::Serialize;
use tracing::{info, warn};

use crate::{
    playback_session::PlaybackTarget,
    sonos::{GroupsResponse, PreferredGroup, SonosControl, SonosGroup},
    sonos_failure, sonos_unavailable, AppState, FrontendUpdate, SonosApiResult,
};

// Group change events normally wake the follower. Polling covers lost events.
const FOLLOW_INTERVAL: Duration = Duration::from_secs(120);
// Speakers take a moment to sync over the LAN after a membership change.
const REGROUP_SETTLE: Duration = Duration::from_secs(1);

fn is_playing(group: &SonosGroup) -> bool {
    matches!(
        group.playback_state.as_deref(),
        Some("PLAYBACK_STATE_PLAYING" | "PLAYBACK_STATE_BUFFERING")
    )
}

fn overlap(group: &SonosGroup, player_ids: &[String]) -> usize {
    group.player_ids.iter().filter(|id| player_ids.contains(id)).count()
}

/// Find the group that now holds the speakers ReiTunes was playing to.
///
/// After a split, the music (and our playback session) stays with one of the
/// fragments. Prefer a playing fragment, then the one with the most of our
/// speakers, then the one that kept the old coordinator.
pub(crate) fn locate_group<'a>(
    groups: &'a GroupsResponse,
    group_id: &str,
    player_ids: &[String],
) -> Option<&'a SonosGroup> {
    if let Some(group) = groups.groups.iter().find(|group| group.id == group_id) {
        return Some(group);
    }
    let old_coordinator = group_id.split(':').next().unwrap_or(group_id).to_string();
    let mut known = player_ids.to_vec();
    if !known.contains(&old_coordinator) {
        known.push(old_coordinator.clone());
    }
    groups
        .groups
        .iter()
        .filter(|group| overlap(group, &known) > 0)
        .max_by_key(|group| {
            (
                is_playing(group),
                overlap(group, &known),
                group.player_ids.contains(&old_coordinator),
            )
        })
}

fn target_for(
    household_id: &str,
    group: &SonosGroup,
    groups: &GroupsResponse,
    preferred_group: bool,
) -> PlaybackTarget {
    let player_names = group
        .player_ids
        .iter()
        .map(|id| {
            groups
                .players
                .iter()
                .find(|player| &player.id == id)
                .map_or_else(|| id.clone(), |player| player.name.clone())
        })
        .collect();
    PlaybackTarget::Sonos {
        household_id: household_id.to_string(),
        group_id: group.id.clone(),
        group_name: group.name.clone(),
        player_names,
        player_ids: group.player_ids.clone(),
        preferred_group,
    }
}

/// Bring the shared Sonos target up to date with Sonos's real grouping.
/// Callers hold the Sonos command lock.
pub(crate) async fn follow_target(app: &AppState, control: &SonosControl) -> Result<()> {
    let Some(state) = app.playback_session.snapshot()?.state else {
        return Ok(());
    };
    let PlaybackTarget::Sonos {
        household_id,
        group_id,
        player_ids,
        preferred_group,
        ..
    } = &state.target
    else {
        return Ok(());
    };
    let groups = control.groups(household_id).await?;
    let Some(group) = locate_group(&groups, group_id, player_ids) else {
        warn!(group_id, "None of the Sonos speakers ReiTunes was using are in a group");
        return Ok(());
    };
    let moved = group.id != *group_id;
    if moved {
        info!(old_group_id = group_id, new_group_id = group.id, "Following the Sonos group to its new ID");
        control.move_group(group_id, &group.id)?;
    }
    let target = target_for(household_id, group, &groups, *preferred_group);
    if let Some(snapshot) = app.playback_session.retarget_sonos(group_id, target)? {
        let _ = app.update_tx.send(FrontendUpdate::PlaybackSession { snapshot });
    }
    if moved && control.has_playback_session(&group.id)? {
        if let Err(error) = control.ensure_event_subscriptions(&group.id).await {
            warn!(%error, group_id = group.id, "Could not subscribe to the moved Sonos group");
        }
    }
    Ok(())
}

pub fn start_group_follower(app: AppState) {
    let Some(control) = app.sonos.clone() else {
        return;
    };
    tokio::spawn(async move {
        loop {
            tokio::select! {
                _ = control.group_changed.notified() => {},
                _ = tokio::time::sleep(FOLLOW_INTERVAL) => {},
            }
            let targets_sonos = app.playback_session.snapshot().is_ok_and(|snapshot| {
                snapshot.state.is_some_and(|state| matches!(state.target, PlaybackTarget::Sonos { .. }))
            });
            if !targets_sonos || !control.status().is_ok_and(|status| status.connected) {
                continue;
            }
            let _command = app.playback_session.sonos_commands.lock().await;
            match tokio::time::timeout(Duration::from_secs(20), follow_target(&app, &control)).await {
                Ok(Ok(())) => {}
                Ok(Err(error)) => warn!(%error, "Could not follow Sonos grouping"),
                Err(_) => warn!("Sonos did not report its groups in time"),
            }
        }
    });
}

fn online_players(preferred: &PreferredGroup, groups: &GroupsResponse) -> Vec<String> {
    preferred
        .player_ids
        .iter()
        .filter(|id| groups.players.iter().any(|player| &player.id == *id))
        .cloned()
        .collect()
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub(crate) struct RegroupResponse {
    group: SonosGroup,
    /// Preferred speakers that are not in the group, usually because they are offline.
    missing_player_ids: Vec<String>,
}

/// Put the preferred speakers into one group. Callers hold the command lock.
///
/// This grows an existing group rather than creating a new one, so the music
/// and ReiTunes's playback session survive: the group ReiTunes is playing to
/// when it shares a speaker with the preferred group, otherwise the largest
/// fragment of the preferred group.
async fn regroup(app: &AppState, control: &SonosControl, preferred: &PreferredGroup) -> Result<RegroupResponse> {
    if let Err(error) = follow_target(app, control).await {
        warn!(%error, "Could not follow Sonos grouping before regrouping");
    }
    let groups = control.groups(&preferred.household_id).await?;
    let online = online_players(preferred, &groups);
    if online.is_empty() {
        bail!("None of the speakers in {} are online", preferred.name);
    }
    let target_id = app.playback_session.snapshot()?.state.and_then(|state| match state.target {
        PlaybackTarget::Sonos { household_id, group_id, .. } if household_id == preferred.household_id => Some(group_id),
        _ => None,
    });
    let base = groups
        .groups
        .iter()
        .find(|group| Some(&group.id) == target_id.as_ref() && overlap(group, &online) > 0)
        .or_else(|| groups.groups.iter().filter(|group| overlap(group, &online) > 0).max_by_key(|group| overlap(group, &online)))
        .ok_or_else(|| anyhow::anyhow!("Sonos did not report a group for the preferred speakers"))?;
    let to_add: Vec<String> = online.iter().filter(|id| !base.player_ids.contains(id)).cloned().collect();
    let mut grouped = base.clone();
    if !to_add.is_empty() {
        info!(group_id = base.id, added = ?to_add, "Regrouping the preferred Sonos group");
        grouped = control.add_group_members(&base.id, &to_add).await?;
        tokio::time::sleep(REGROUP_SETTLE).await;
        // Sonos's reply only lists the final players; it is the source of truth
        // for partial success. Following updates the shared target's members.
        if let Err(error) = follow_target(app, control).await {
            warn!(%error, "Could not follow Sonos grouping after regrouping");
        }
    }
    let missing_player_ids = preferred
        .player_ids
        .iter()
        .filter(|id| !grouped.player_ids.contains(id))
        .cloned()
        .collect();
    Ok(RegroupResponse { group: grouped, missing_player_ids })
}

/// Before playing to the preferred group, put back any speakers that drifted
/// out of it. Failure only costs the missing speakers, so it never blocks playback.
pub(crate) async fn top_up_preferred_group(app: &AppState, control: &SonosControl, group_id: &str) {
    let top_up = async {
        let Some(state) = app.playback_session.snapshot()?.state else {
            return Ok(());
        };
        let PlaybackTarget::Sonos { household_id, group_id: target_id, preferred_group: true, .. } = &state.target
        else {
            return Ok(());
        };
        let Some(preferred) = control.preferred_group()? else {
            return Ok(());
        };
        if target_id != group_id || preferred.household_id != *household_id {
            return Ok(());
        }
        let groups = control.groups(household_id).await?;
        let Some(group) = groups.groups.iter().find(|group| group.id == group_id) else {
            return Ok(());
        };
        let missing: Vec<String> = online_players(&preferred, &groups)
            .into_iter()
            .filter(|id| !group.player_ids.contains(id))
            .collect();
        if missing.is_empty() {
            return Ok(());
        }
        info!(group_id, added = ?missing, "Regrouping drifted Sonos speakers before playback");
        control.add_group_members(group_id, &missing).await?;
        control.group_changed.notify_one();
        anyhow::Ok(())
    };
    match tokio::time::timeout(Duration::from_secs(10), top_up).await {
        Ok(Ok(())) => {}
        Ok(Err(error)) => warn!(%error, group_id, "Could not regroup Sonos speakers before playback"),
        Err(_) => warn!(group_id, "Sonos did not regroup in time; playing to the current group"),
    }
}

fn validate_preferred_group(group: &PreferredGroup) -> Result<()> {
    fn short(value: &str) -> Result<()> {
        if value.is_empty() || value.len() > 500 {
            bail!("A preferred group identifier or name has an invalid length");
        }
        Ok(())
    }
    short(&group.household_id)?;
    short(&group.name)?;
    if group.player_ids.is_empty() || group.player_ids.len() > 32 {
        bail!("A preferred group needs between 1 and 32 speakers");
    }
    if group.player_names.len() != group.player_ids.len() {
        bail!("Each preferred speaker needs a name");
    }
    for value in group.player_ids.iter().chain(&group.player_names) {
        short(value)?;
    }
    if group.player_ids.iter().collect::<HashSet<_>>().len() != group.player_ids.len() {
        bail!("Preferred speakers must be distinct");
    }
    Ok(())
}

pub(crate) async fn preferred_group_handler(
    State(app): State<AppState>,
) -> SonosApiResult<Json<Option<PreferredGroup>>> {
    let control = app.sonos.ok_or_else(sonos_unavailable)?;
    control.preferred_group().map(Json).map_err(sonos_failure)
}

pub(crate) async fn save_preferred_group_handler(
    State(app): State<AppState>,
    crate::JsonExtractor(group): crate::JsonExtractor<PreferredGroup>,
) -> SonosApiResult<StatusCode> {
    let control = app.sonos.ok_or_else(sonos_unavailable)?;
    validate_preferred_group(&group).map_err(|error| {
        (StatusCode::BAD_REQUEST, Json(crate::SonosApiError { error: error.to_string(), code: None }))
    })?;
    control.save_preferred_group(&group).map_err(sonos_failure)?;
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn forget_preferred_group_handler(State(app): State<AppState>) -> SonosApiResult<StatusCode> {
    let control = app.sonos.ok_or_else(sonos_unavailable)?;
    control.forget_preferred_group().map_err(sonos_failure)?;
    Ok(StatusCode::NO_CONTENT)
}

pub(crate) async fn regroup_handler(State(app): State<AppState>) -> SonosApiResult<Json<RegroupResponse>> {
    let control = app.sonos.clone().ok_or_else(sonos_unavailable)?;
    let preferred = control
        .preferred_group()
        .map_err(sonos_failure)?
        .ok_or_else(|| (StatusCode::NOT_FOUND, Json(crate::SonosApiError {
            error: "Save a preferred Sonos group first".into(),
            code: None,
        })))?;
    crate::with_sonos_deadline(Duration::from_secs(30), async {
        let _command = app.playback_session.sonos_commands.lock().await;
        regroup(&app, &control, &preferred).await.map(Json).map_err(sonos_failure)
    })
    .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sonos::SonosPlayer;

    fn group(id: &str, players: &[&str], state: &str) -> SonosGroup {
        SonosGroup {
            id: id.into(),
            name: id.into(),
            coordinator_id: players[0].into(),
            player_ids: players.iter().map(|id| id.to_string()).collect(),
            playback_state: Some(state.into()),
        }
    }

    fn household(groups: Vec<SonosGroup>) -> GroupsResponse {
        let players = groups
            .iter()
            .flat_map(|group| group.player_ids.clone())
            .map(|id| SonosPlayer {
                name: format!("{id} name"),
                id,
                capabilities: vec![],
                websocket_url: None,
                software_version: None,
                api_version: None,
                min_api_version: None,
                is_unregistered: None,
            })
            .collect();
        GroupsResponse { groups, players }
    }

    const ALL: [&str; 4] = ["A", "B", "C", "D"];

    fn ids(players: &[&str]) -> Vec<String> {
        players.iter().map(|id| id.to_string()).collect()
    }

    #[test]
    fn keeps_a_group_whose_id_survived_even_when_members_left() {
        let groups = household(vec![
            group("A:1", &["A", "B"], "PLAYBACK_STATE_PLAYING"),
            group("C:7", &["C", "D"], "PLAYBACK_STATE_IDLE"),
        ]);
        assert_eq!(locate_group(&groups, "A:1", &ids(&ALL)).unwrap().id, "A:1");
    }

    #[test]
    fn follows_the_playing_fragment_after_a_split() {
        let groups = household(vec![
            group("A:2", &["A"], "PLAYBACK_STATE_IDLE"),
            group("B:3", &["B"], "PLAYBACK_STATE_PLAYING"),
            group("C:4", &["C"], "PLAYBACK_STATE_IDLE"),
            group("D:5", &["D"], "PLAYBACK_STATE_IDLE"),
        ]);
        assert_eq!(locate_group(&groups, "A:1", &ids(&ALL)).unwrap().id, "B:3");
    }

    #[test]
    fn without_playback_prefers_most_speakers_then_the_old_coordinator() {
        let groups = household(vec![
            group("C:4", &["C", "D"], "PLAYBACK_STATE_PAUSED"),
            group("A:2", &["A"], "PLAYBACK_STATE_PAUSED"),
            group("B:3", &["B"], "PLAYBACK_STATE_PAUSED"),
        ]);
        assert_eq!(locate_group(&groups, "A:1", &ids(&ALL)).unwrap().id, "C:4");
        let even = household(vec![
            group("B:3", &["B"], "PLAYBACK_STATE_PAUSED"),
            group("A:2", &["A"], "PLAYBACK_STATE_PAUSED"),
        ]);
        assert_eq!(locate_group(&even, "A:1", &ids(&["A", "B"])).unwrap().id, "A:2");
    }

    #[test]
    fn targets_saved_before_player_ids_still_follow_the_coordinator() {
        let groups = household(vec![
            group("Z:9", &["Z"], "PLAYBACK_STATE_PLAYING"),
            group("A:2", &["A", "B"], "PLAYBACK_STATE_IDLE"),
        ]);
        assert_eq!(locate_group(&groups, "A:1", &[]).unwrap().id, "A:2");
        assert!(locate_group(&household(vec![group("Z:9", &["Z"], "PLAYBACK_STATE_IDLE")]), "A:1", &[]).is_none());
    }

    #[test]
    fn retargeting_names_every_current_member() {
        let groups = household(vec![group("A:1", &["A", "C"], "PLAYBACK_STATE_PLAYING")]);
        let PlaybackTarget::Sonos { player_names, player_ids, preferred_group, .. } =
            target_for("home", &groups.groups[0], &groups, true)
        else {
            unreachable!()
        };
        assert_eq!(player_names, ["A name", "C name"]);
        assert_eq!(player_ids, ["A", "C"]);
        assert!(preferred_group);
    }

    #[test]
    fn preferred_groups_need_distinct_named_speakers() {
        let valid = PreferredGroup {
            household_id: "home".into(),
            name: "Whole house".into(),
            player_ids: ids(&["A", "B"]),
            player_names: ids(&["Kitchen", "Den"]),
        };
        assert!(validate_preferred_group(&valid).is_ok());
        let duplicate = PreferredGroup { player_ids: ids(&["A", "A"]), ..valid.clone() };
        assert!(validate_preferred_group(&duplicate).is_err());
        let unnamed = PreferredGroup { player_names: ids(&["Kitchen"]), ..valid };
        assert!(validate_preferred_group(&unnamed).is_err());
    }
}

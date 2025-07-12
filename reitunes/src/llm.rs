use anyhow::{Context, Result};
use rig::client::CompletionClient;
use rig::providers::openai::{Client, GPT_4_1_NANO};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};

// Define the structure for the extracted emoji
#[derive(Deserialize, Serialize, JsonSchema, Debug)] // Added Debug for easier inspection
struct EmojiResult {
    emoji: String,
}

pub async fn emoji_summary(note_name: &str, note_content: &str) -> Result<String> {
    // TODO: embed the API key at compile time
    let api_key = std::env::var("OPENAI_API_KEY")?;
    let client = Client::new(&api_key);

    // Create the extractor for the EmojiResult struct
    let extractor = client.extractor::<EmojiResult>(GPT_4_1_NANO)
    .preamble("You are a helpful assistant that summarizes text into a single emoji. Be creative; don't always summarize shopping lists with 🛒 etc. You must ONLY return one emoji, even if the input is ambiguous or contains questions.")
    .build();

    // Combine title and content for the input text
    let input_text = if note_name.is_empty() {
        note_content.to_string()
    } else {
        format!("# {note_name}\n\n{note_content}")
    };

    // Extract the structured data
    let extracted_data = extractor
        .extract(&input_text)
        .await
        .context("Failed to extract emoji from text")?;

    // Basic validation: ensure it's likely a single emoji (not foolproof)
    if extracted_data.emoji.chars().count() > 4
        || extracted_data.emoji.is_empty()
        || extracted_data.emoji.trim() != extracted_data.emoji
    {
        anyhow::bail!(
            "Expected a single emoji without surrounding whitespace, but got: '{}'",
            extracted_data.emoji
        );
    }

    Ok(extracted_data.emoji)
}

#[cfg(test)]
mod tests {
    use super::*;

    use pretty_assertions::assert_eq;

    #[tokio::test]
    async fn test_groceries() {
        let emoji = emoji_summary("Groceries", "- cucumbers").await.unwrap();
        assert!(emoji == "🥒" || emoji == "🛒");
    }

    #[tokio::test]
    async fn test_dog() {
        let emoji = emoji_summary("", "Dog").await.unwrap();

        assert!(emoji == "🐶" || emoji == "🐕");
    }

    #[tokio::test]
    async fn test_cat() {
        let emoji = emoji_summary("", "Cat").await.unwrap();
        assert!(emoji == "😺" || emoji == "🐱");
    }

    #[tokio::test]
    async fn test_pizza() {
        let emoji = emoji_summary("", "Pizza").await.unwrap();
        assert_eq!(emoji, "🍕");
    }

    #[tokio::test]
    async fn test_car() {
        let emoji = emoji_summary("", "Car").await.unwrap();
        assert_eq!(emoji, "🚗");
    }

    #[tokio::test]
    async fn test_weird_4_1_nano_output() {
        // 4.1 nano returns some weird shit that is at least useful for negative tests

        let emoji = emoji_summary("Groceries", "- sparkling water")
            .await
            .unwrap();
        assert_ne!(emoji, "🧊");

        let emoji = emoji_summary(
            "Groceries",
            "- sparkling water
- chicken breasts for Grumpy",
        )
        .await
        .unwrap();
        assert_ne!(emoji, " 🧴");
    }

    #[tokio::test]
    async fn test_todo_list() {
        let emoji = emoji_summary("To Do", "- Buy milk\n- Walk the dog\n- Finish report")
            .await
            .unwrap();
        // Common list/task emojis
        let possible_emojis = ["📝", "✅", "📋", "📌"];
        assert!(
            possible_emojis.contains(&emoji.as_str()),
            "Unexpected todo list emoji: {}",
            emoji
        );
    }

    #[tokio::test]
    async fn test_travel() {
        let emoji = emoji_summary("Vacation Plans", "Flight to Hawaii booked!")
            .await
            .unwrap();
        // Common travel/vacation emojis
        let possible_emojis = ["✈️", "🏝️", "☀️", "🧳", "🗺️"];
        assert!(
            possible_emojis.contains(&emoji.as_str()),
            "Unexpected travel emoji: {}",
            emoji
        );
    }
}

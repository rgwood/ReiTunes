//! Shared functionality for reitunes workspace
//!
//! This library contains common database operations, library management,
//! and utility functions shared between the reitunes web server and sonos-player.

pub mod database;
pub mod library;
pub mod utils;

// Re-export commonly used types and functions
pub use database::*;
pub use library::*;
pub use utils::*;

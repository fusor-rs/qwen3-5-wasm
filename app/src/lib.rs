//! The Qwen3.5 page. The conversation, the next message (its text, images, videos and how to
//! reply) and the live measurements are signals here; `web/app.js` decodes the images and
//! videos, runs the engine worker and reports back through `engine` events.

mod app;
mod examples;
mod markdown;

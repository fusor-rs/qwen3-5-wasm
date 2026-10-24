use fusor::{JsInputs, Signal, signal};
use serde::{Deserialize, Serialize};

use crate::examples::{EXAMPLES, Example};
use crate::markdown::{self, Block};

/// An image or video added to a message, once decoded.
#[derive(Clone, PartialEq, Deserialize)]
struct Medium {
    index: usize,
    name: String,
    width: u32,
    height: u32,
    /// A video's sampled frames; none for an image.
    #[serde(default)]
    frames: Option<u32>,
}

impl Medium {
    fn summary(&self) -> String {
        let frames = self
            .frames
            .map_or(String::new(), |frames| format!(" · {frames} frames"));
        format!("{} · {}×{}{frames}", self.name, self.width, self.height)
    }
}

/// Who wrote a message.
#[derive(Clone, Copy, PartialEq)]
enum Role {
    User,
    Model,
}

impl Role {
    fn name(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Model => "model",
        }
    }
}

/// A message of the conversation as the page shows it, a reply's reasoning apart.
#[derive(Clone, PartialEq)]
struct Entry {
    index: usize,
    role: Role,
    text: String,
    reasoning: Option<String>,
    media: Vec<Medium>,
}

impl Entry {
    fn new(index: usize, role: Role, text: String, media: Vec<Medium>) -> Self {
        Self {
            index,
            role,
            text,
            reasoning: None,
            media,
        }
    }

    fn reasons(&self) -> bool {
        self.reasoning.is_some()
    }

    fn is_user(&self) -> bool {
        self.role == Role::User
    }

    /// A reply's Markdown, drawn.
    fn blocks(&self) -> Vec<Block> {
        markdown::blocks(&self.text)
    }

    fn reasoning(&self) -> String {
        // Shown only for a reply that reasons.
        self.reasoning.clone().unwrap_or_default()
    }
}

/// The runtime's sampling: `qwen3_5::sampling::Sampling`.
#[derive(Serialize)]
struct Sampling {
    temperature: f64,
    top_p: f64,
    top_k: u32,
    presence_penalty: f64,
}

/// The runtime's message, `qwen3_5::session::Message`, but its seed, which `web/app.js` draws.
#[derive(Serialize)]
struct Message {
    text: String,
    thinking: bool,
    max_tokens: u32,
    /// None for the model card's settings.
    sampling: Option<Sampling>,
}

// The runtime build and the bundle, once loaded.
#[derive(Clone, PartialEq, Deserialize)]
struct Loaded {
    build: String,
    threads: u32,
    bundle_bytes: f64,
    load_ms: f64,
    // Every part came from this device's storage.
    from_device: bool,
}

impl Loaded {
    fn summary(&self) -> String {
        let threads = match self.threads {
            1 => "1 thread".to_string(),
            count => format!("{count} threads"),
        };
        let source = if self.from_device {
            "model loaded from this device"
        } else {
            "model downloaded"
        };
        format!(
            "{} · {threads} · {:.0} MB bundle · {source} in {:.1} s",
            self.build,
            self.bundle_bytes / 1e6,
            self.load_ms / 1000.0
        )
    }
}

/// What `web/app.js` measures while a reply is written: the delay from Send to its first token
/// (`first_ms`), the tokens written and the time since that first one (`writing_ms`), the
/// conversation's tokens and those this turn read, and the network requests made since the
/// model loaded.
#[derive(Clone, Default, PartialEq, Deserialize)]
struct Metrics {
    first_ms: Option<f64>,
    tokens: u32,
    writing_ms: f64,
    context_tokens: u32,
    read_tokens: u32,
    requests: u32,
}

impl Metrics {
    fn first_token(&self) -> String {
        self.first_ms
            .map_or("–".into(), |ms| format!("{:.2} s", ms / 1000.0))
    }

    fn speed(&self) -> String {
        if self.tokens < 2 || self.writing_ms == 0.0 {
            return "–".into();
        }
        format!(
            "{:.1}/s",
            f64::from(self.tokens - 1) * 1000.0 / self.writing_ms
        )
    }

    fn tokens(&self) -> String {
        self.tokens.to_string()
    }

    fn context(&self) -> String {
        self.context_tokens.to_string()
    }

    fn read(&self) -> String {
        format!("{} read this turn", self.read_tokens)
    }

    fn requests(&self) -> String {
        self.requests.to_string()
    }
}

// What `web/app.js` reports, one JSON object per `engine` event.
#[derive(Deserialize)]
#[serde(tag = "type", rename_all = "lowercase")]
enum Report {
    Loading {
        fraction: f64,
        detail: String,
    },
    Ready {
        loaded: Loaded,
    },
    // The next message's images and videos, after one was added or they were removed.
    Media {
        media: Vec<Medium>,
    },
    // The reply so far.
    Reply {
        status: String,
        reasoning: Option<String>,
        answer: String,
        metrics: Metrics,
    },
    // The reply is written, or stopped.
    Done {
        status: String,
        metrics: Metrics,
    },
    // Something failed; the engine can take the next message.
    Error {
        message: String,
    },
    // The model could not load, or the engine died: nothing more can run in this page.
    Broken {
        message: String,
    },
}

#[derive(Clone, Copy, PartialEq)]
enum Phase {
    Idle,
    Replying,
    Broken,
}

impl Phase {
    fn name(self) -> &'static str {
        match self {
            Self::Idle => "idle",
            Self::Replying => "replying",
            Self::Broken => "broken",
        }
    }
}

/// The longest reply the page asks for unless told otherwise.
const MAX_TOKENS: u32 = 2048;

#[derive(JsInputs)]
struct App {
    text: Signal<String>,
    thinking: Signal<bool>,
    // The model card's settings for the turn, unless the fields below are used.
    card_sampling: Signal<bool>,
    temperature: Signal<f64>,
    top_p: Signal<f64>,
    top_k: Signal<u32>,
    presence_penalty: Signal<f64>,
    max_tokens: Signal<u32>,
    // `web/app.js` acts on every new count: `sends` (Send) sends `message` and the media to the
    // engine, `stops` stops the reply, `clears` forgets the media, `resets` starts a new
    // conversation, `attaches` replaces the media with the example's, `attach` (paths, as JSON).
    #[js]
    message: Signal<String>,
    #[js]
    attach: Signal<String>,
    #[js]
    sends: Signal<u32>,
    #[js]
    stops: Signal<u32>,
    #[js]
    clears: Signal<u32>,
    #[js]
    resets: Signal<u32>,
    #[js]
    attaches: Signal<u32>,
    phase: Signal<Phase>,
    fraction: Signal<f64>,
    detail: Signal<String>,
    status: Signal<String>,
    media: Signal<Vec<Medium>>,
    entries: Signal<Vec<Entry>>,
    metrics: Signal<Metrics>,
    loaded: Signal<Option<Loaded>>,
}

impl App {
    fn new() -> Self {
        Self {
            text: signal(String::new()),
            thinking: signal(false),
            card_sampling: signal(true),
            temperature: signal(0.7),
            top_p: signal(0.8),
            top_k: signal(20),
            presence_penalty: signal(1.5),
            max_tokens: signal(MAX_TOKENS),
            message: signal(String::new()),
            attach: signal("[]".into()),
            sends: signal(0),
            stops: signal(0),
            clears: signal(0),
            resets: signal(0),
            attaches: signal(0),
            phase: signal(Phase::Idle),
            fraction: signal(0.0),
            detail: signal("Starting…".into()),
            status: signal("Write a message, or start from an example.".into()),
            media: signal(Vec::new()),
            entries: signal(Vec::new()),
            metrics: signal(Metrics::default()),
            loaded: signal(None),
        }
    }

    fn examples(&self) -> Vec<Example> {
        EXAMPLES.to_vec()
    }

    fn pick(&self, example: &Example) {
        self.text.set(example.text.into());
        let paths = serde_json::to_string(example.media).expect("paths serialize");
        self.attach.set(paths);
        self.attaches.update(|count| *count += 1);
    }

    fn send(&self) {
        let text = self.text.get();
        let media = self.media.get();
        if text.trim().is_empty() && media.is_empty() {
            return self.status.set("Write a message first.".into());
        }
        let sampling = (!self.card_sampling.get()).then(|| Sampling {
            temperature: self.temperature.get(),
            top_p: self.top_p.get(),
            top_k: self.top_k.get(),
            presence_penalty: self.presence_penalty.get(),
        });
        let message = Message {
            text: text.clone(),
            thinking: self.thinking.get(),
            max_tokens: self.max_tokens.get(),
            sampling,
        };
        self.message
            .set(serde_json::to_string(&message).expect("a message serializes"));
        self.entries.update(|entries| {
            let index = entries.len();
            entries.push(Entry::new(index, Role::User, text, media));
            entries.push(Entry::new(
                index + 1,
                Role::Model,
                String::new(),
                Vec::new(),
            ));
        });
        self.text.set(String::new());
        self.media.set(Vec::new());
        self.metrics.set(Metrics::default());
        self.phase.set(Phase::Replying);
        let status = if self.loaded.get().is_some() {
            "Reading the message…"
        } else {
            "Replying once the model is ready."
        };
        self.status.set(status.into());
        self.sends.update(|count| *count += 1);
    }

    fn stop(&self) {
        self.stops.update(|count| *count += 1);
    }

    fn clear(&self) {
        self.clears.update(|count| *count += 1);
    }

    fn reset(&self) {
        self.entries.set(Vec::new());
        self.metrics.set(Metrics::default());
        self.status.set("A new conversation.".into());
        self.resets.update(|count| *count += 1);
    }

    fn receive(&self, event: web_sys::Event) {
        let json = fusor::js::event_detail::<String>(&event).expect("web/app.js sends strings");
        let report = serde_json::from_str(&json).expect("web/app.js sends engine reports");
        match report {
            Report::Loading { fraction, detail } => {
                self.fraction.set(fraction);
                self.detail.set(detail);
            }
            Report::Ready { loaded } => self.loaded.set(Some(loaded)),
            Report::Media { media } => self.media.set(media),
            Report::Reply {
                status,
                reasoning,
                answer,
                metrics,
            } => {
                self.entries.update(|entries| {
                    let reply = entries.last_mut().expect("a reply follows its message");
                    reply.text = answer;
                    reply.reasoning = reasoning;
                });
                self.status.set(status);
                self.metrics.set(metrics);
            }
            Report::Done { status, metrics } => {
                self.status.set(status);
                self.metrics.set(metrics);
                self.phase.set(Phase::Idle);
            }
            Report::Error { message } => {
                self.status.set(format!("error: {message}"));
                self.phase.set(Phase::Idle);
            }
            Report::Broken { message } => {
                self.detail.set(message);
                self.phase.set(Phase::Broken);
            }
        }
    }

    fn summary(&self) -> String {
        self.loaded
            .get()
            .map_or(String::new(), |loaded| loaded.summary())
    }

    fn loading(&self) -> bool {
        self.loaded.get().is_none() && self.phase.get() != Phase::Broken
    }

    // The model never loaded: likely a bundle that does not match the runtime.
    fn failed_to_load(&self) -> bool {
        self.loaded.get().is_none()
    }

    fn idle(&self) -> bool {
        self.phase.get() == Phase::Idle
    }

    fn send_label(&self) -> &'static str {
        match self.phase.get() {
            Phase::Replying => "Replying…",
            _ if self.loaded.get().is_none() => "Send now, replies when ready",
            _ => "Send",
        }
    }

    fn empty(&self) -> bool {
        self.entries.get().is_empty()
    }
}

fusor::template!("web/index.html");

//! The messages the page offers to start from, with the image or video they ask about: the d3
//! model card's example receipt and clip, and a question in words alone.

/// An example message: its text and its media's paths under `/examples/`.
#[derive(Clone, PartialEq)]
pub(crate) struct Example {
    pub(crate) id: &'static str,
    pub(crate) label: &'static str,
    pub(crate) text: &'static str,
    pub(crate) media: &'static [&'static str],
}

pub(crate) const EXAMPLES: [Example; 3] = [
    Example {
        id: "receipt",
        label: "Receipt",
        text: "What is the total on this receipt, and how was it paid?",
        media: &["example-receipt.png"],
    },
    Example {
        id: "clip",
        label: "Video clip",
        text: "Which way does the square move? Answer in one sentence.",
        media: &["example-video.webm"],
    },
    Example {
        id: "colors",
        label: "A question",
        text: "Name the three primary colors of light, in one sentence.",
        media: &[],
    },
];

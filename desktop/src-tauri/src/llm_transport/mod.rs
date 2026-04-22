mod error;
mod openai;

pub(crate) use error::{LlmTransportError, TransportErrorKind, TransportMode};
pub(crate) use openai::{
    run_openai_json_chat_completion_transport, run_openai_streaming_chat_completion_transport,
};

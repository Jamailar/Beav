use serde_json::{json, Value};

#[derive(Debug, Clone)]
pub(crate) struct AcpHttpError {
    pub(crate) status: u16,
    pub(crate) status_text: &'static str,
    pub(crate) code: &'static str,
    pub(crate) message: String,
}

impl AcpHttpError {
    pub(crate) fn bad_request(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: 400,
            status_text: "Bad Request",
            code,
            message: message.into(),
        }
    }

    pub(crate) fn unauthorized(message: impl Into<String>) -> Self {
        Self {
            status: 401,
            status_text: "Unauthorized",
            code: "unauthorized",
            message: message.into(),
        }
    }

    pub(crate) fn forbidden(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: 403,
            status_text: "Forbidden",
            code,
            message: message.into(),
        }
    }

    pub(crate) fn not_found(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            status: 404,
            status_text: "Not Found",
            code,
            message: message.into(),
        }
    }

    pub(crate) fn internal(message: impl Into<String>) -> Self {
        Self {
            status: 500,
            status_text: "Internal Server Error",
            code: "internal_error",
            message: message.into(),
        }
    }

    pub(crate) fn value(&self) -> Value {
        json!({
            "success": false,
            "error": {
                "code": self.code,
                "message": self.message,
            }
        })
    }
}

impl From<String> for AcpHttpError {
    fn from(value: String) -> Self {
        Self::internal(value)
    }
}

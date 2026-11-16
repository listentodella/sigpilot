//! SDK-level tool forwarding to one explicit desktop instance.
use rmcp::{
    model::{
        CallToolRequestParams, CallToolResponse, Implementation, ListToolsResult,
        PaginatedRequestParams, ServerCapabilities, ServerConfig, Tool,
    },
    service::{Peer, RequestContext, RoleClient, RoleServer},
    ErrorData, ServerHandler,
};
use std::{sync::Arc, time::Duration};

#[derive(Clone)]
pub struct DesktopBridge {
    pub upstream: Peer<RoleClient>,
    pub tools: Arc<Vec<Tool>>,
    pub budget: Arc<tokio::sync::Semaphore>,
}

impl ServerHandler for DesktopBridge {
    fn get_info(&self) -> ServerConfig {
        ServerConfig::new(ServerCapabilities::builder().enable_tools().enable_resources().enable_prompts().build())
            .with_server_info(Implementation::new("sigpilot-desktop-bridge", env!("CARGO_PKG_VERSION")))
            .with_instructions("Tools access the explicitly selected desktop instance. Exact sample coordinates are decimal strings; ranges are half-open.")
    }
    fn get_tool(&self, name: &str) -> Option<Tool> {
        self.tools.iter().find(|t| t.name == name).cloned()
    }
    async fn list_prompts(
        &self,
        request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<rmcp::model::ListPromptsResult, ErrorData> {
        let _permit = self
            .budget
            .try_acquire()
            .map_err(|_| ErrorData::internal_error("bridge busy", None))?;
        tokio::select! {
            r=tokio::time::timeout(Duration::from_secs(15),self.upstream.list_prompts(request))=>r.map_err(|_|ErrorData::internal_error("desktop prompt request timed out",None))?
                .map_err(|e|match e {rmcp::service::ServiceError::McpError(error)=>error,_=>ErrorData::internal_error("selected desktop prompt service is unavailable",None)}),
            _=context.ct.cancelled()=>Err(ErrorData::internal_error("prompt request cancelled",None)),
        }
    }
    async fn get_prompt(
        &self,
        request: rmcp::model::GetPromptRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<rmcp::model::GetPromptResponse, ErrorData> {
        if serde_json::to_vec(&request).map_or(true, |r| r.len() > 4096) {
            return Err(ErrorData::invalid_params(
                "prompt request exceeds 4 KiB",
                None,
            ));
        }
        let _permit = self
            .budget
            .try_acquire()
            .map_err(|_| ErrorData::internal_error("bridge busy", None))?;
        tokio::select! {
            r=tokio::time::timeout(Duration::from_secs(15),self.upstream.get_prompt_once(request))=>r.map_err(|_|ErrorData::internal_error("desktop prompt request timed out",None))?
                .map_err(|e|match e {rmcp::service::ServiceError::McpError(error)=>error,_=>ErrorData::internal_error("selected desktop prompt service is unavailable",None)}),
            _=context.ct.cancelled()=>Err(ErrorData::internal_error("prompt request cancelled",None)),
        }
    }

    async fn list_resources(
        &self,
        request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<rmcp::model::ListResourcesResult, ErrorData> {
        let _permit = self
            .budget
            .try_acquire()
            .map_err(|_| ErrorData::internal_error("bridge busy", None))?;
        tokio::select! {
            r=tokio::time::timeout(Duration::from_secs(15),self.upstream.list_resources(request))=>r.map_err(|_|ErrorData::internal_error("desktop resource request timed out",None))?
                .map_err(|_|ErrorData::internal_error("selected desktop resource service is unavailable",None)),
            _=context.ct.cancelled()=>Err(ErrorData::internal_error("resource request cancelled",None)),
        }
    }
    async fn list_resource_templates(
        &self,
        request: Option<PaginatedRequestParams>,
        context: RequestContext<RoleServer>,
    ) -> Result<rmcp::model::ListResourceTemplatesResult, ErrorData> {
        let _permit = self
            .budget
            .try_acquire()
            .map_err(|_| ErrorData::internal_error("bridge busy", None))?;
        tokio::select! {
            r=tokio::time::timeout(Duration::from_secs(15),self.upstream.list_resource_templates(request))=>r.map_err(|_|ErrorData::internal_error("desktop resource request timed out",None))?
                .map_err(|_|ErrorData::internal_error("selected desktop resource service is unavailable",None)),
            _=context.ct.cancelled()=>Err(ErrorData::internal_error("resource request cancelled",None)),
        }
    }
    async fn read_resource(
        &self,
        request: rmcp::model::ReadResourceRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<rmcp::model::ReadResourceResponse, ErrorData> {
        if request.uri.len() > 1024 {
            return Err(ErrorData::invalid_params(
                "resource URI exceeds 1024 bytes",
                None,
            ));
        }
        let _permit = self
            .budget
            .try_acquire()
            .map_err(|_| ErrorData::internal_error("bridge busy", None))?;
        tokio::select! {
            r=tokio::time::timeout(Duration::from_secs(15),self.upstream.read_resource_once(request))=>r.map_err(|_|ErrorData::internal_error("desktop resource request timed out",None))?
                .map_err(|e|match e {rmcp::service::ServiceError::McpError(error)=>error,_=>ErrorData::internal_error("selected desktop resource service is unavailable",None)}),
            _=context.ct.cancelled()=>Err(ErrorData::internal_error("resource request cancelled",None)),
        }
    }
    async fn list_tools(
        &self,
        _: Option<PaginatedRequestParams>,
        _: RequestContext<RoleServer>,
    ) -> Result<ListToolsResult, ErrorData> {
        Ok(ListToolsResult {
            tools: self.tools.as_ref().clone(),
            ..Default::default()
        })
    }
    async fn call_tool(
        &self,
        request: CallToolRequestParams,
        context: RequestContext<RoleServer>,
    ) -> Result<CallToolResponse, ErrorData> {
        if self.get_tool(&request.name).is_none() {
            return Err(ErrorData::invalid_params(
                "unknown or unauthorized desktop tool",
                None,
            ));
        }
        if serde_json::to_vec(&request).map_or(true, |data| data.len() > 240 * 1024) {
            return Err(ErrorData::invalid_params(
                "tool request exceeds 240 KiB",
                None,
            ));
        }
        let _permit = self
            .budget
            .try_acquire()
            .map_err(|_| ErrorData::internal_error("bridge busy", None))?;
        // Dropping the SDK request future propagates cancellation upstream.
        tokio::select! {
            result = tokio::time::timeout(Duration::from_secs(15), self.upstream.call_tool_once(request)) => {
                result.map_err(|_| ErrorData::internal_error("desktop request timed out; reacquire context before retrying a write", None))?
                    .map_err(|_| ErrorData::internal_error("selected desktop instance is unavailable", None))
            },
            _ = context.ct.cancelled() => Err(ErrorData::internal_error("request cancelled", None)),
        }
    }
}

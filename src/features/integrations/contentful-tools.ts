/**
 * Contentful remote MCP inventory reviewed 2026-11-15: the tool table at
 * https://www.contentful.com/developers/docs/tools/mcp-server/#tools plus every tool registered in
 * contentful/contentful-mcp-server (its register.ts annotations). Shared by the global and EU hosts.
 * `create_upload_session` is remote-only and returns a bearer upload capability, so it is gated.
 */
export const CONTENTFUL_DESTRUCTIVE_TOOLS = [
  "append_entry_field", "archive_asset", "archive_entry", "cancel_scheduled_release",
  "create_ai_action", "create_component", "create_concept", "create_concept_scheme",
  "create_content_type", "create_data_assembly", "create_entry", "create_environment",
  "create_experience", "create_experience_fragment", "create_experience_template", "create_locale",
  "create_release", "create_tag", "create_upload_session", "delete_ai_action", "delete_asset",
  "delete_component", "delete_concept", "delete_concept_scheme", "delete_content_type",
  "delete_content_type_field", "delete_data_assembly", "delete_design_token", "delete_entry",
  "delete_environment", "delete_experience", "delete_experience_fragment",
  "delete_experience_template", "delete_locale", "delete_release", "disable_content_type_field",
  "import_space", "invoke_ai_action", "omit_content_type_field", "patch_entry",
  "publish_ai_action", "publish_asset", "publish_component", "publish_content_type",
  "publish_data_assembly", "publish_entry", "publish_experience", "publish_experience_fragment",
  "publish_experience_template", "publish_release", "schedule_publish_release",
  "schedule_unpublish_release", "space_to_space_migration_handler", "unarchive_asset",
  "unarchive_entry", "unpublish_ai_action", "unpublish_asset", "unpublish_component",
  "unpublish_content_type", "unpublish_data_assembly", "unpublish_entry", "unpublish_experience",
  "unpublish_experience_fragment", "unpublish_experience_template", "unpublish_release",
  "update_ai_action", "update_asset", "update_concept", "update_concept_scheme",
  "update_content_type", "update_data_assembly", "update_editor_interface", "update_entry",
  "update_experience_fragment", "update_locale", "update_release", "upload_asset",
  "upsert_component", "upsert_design_token", "upsert_experience", "upsert_experience_template",
  "validate_release",
] as const;

/**
 * Side-effect-free reads annotated read-only in the same source. Semantic search, AI Action
 * invocation results, space export, migration planning, usage data and preview URLs (which can
 * carry preview tokens) stay gated. Never overlaps CONTENTFUL_DESTRUCTIVE_TOOLS.
 */
export const CONTENTFUL_READ_TOOLS = [
  "get_ai_action", "get_asset", "get_component", "get_concept", "get_concept_scheme",
  "get_content_type", "get_data_assembly", "get_design_token", "get_editor_interface", "get_entry",
  "get_entry_snapshot", "get_experience", "get_experience_fragment", "get_experience_template",
  "get_initial_context", "get_locale", "get_org", "get_published_data_assembly", "get_release",
  "get_release_action", "get_space", "list_ai_actions", "list_assets", "list_components",
  "list_concept_schemes", "list_concepts", "list_content_types", "list_data_assemblies",
  "list_design_tokens", "list_editor_interfaces", "list_environments", "list_experience_fragments",
  "list_experience_templates", "list_experiences", "list_locales", "list_orgs",
  "list_published_data_assemblies", "list_release_actions", "list_releases",
  "list_scheduled_actions", "list_spaces", "list_tags", "resolve_entry_references",
  "search_entries",
] as const;

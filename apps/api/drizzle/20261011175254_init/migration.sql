CREATE SCHEMA "iam";
--> statement-breakpoint
CREATE TABLE "audit_logs" (
	"id" uuid PRIMARY KEY,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"actor_user_id" uuid,
	"tenant_id" uuid,
	"action" text NOT NULL,
	"target_type" text,
	"target_id" uuid,
	"changes" jsonb,
	"request_id" text,
	"ip" inet,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "brand_assets" (
	"id" uuid PRIMARY KEY,
	"content_type" text NOT NULL,
	"bytes" bytea NOT NULL,
	"size" integer NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "branding" (
	"id" uuid PRIMARY KEY,
	"tenant_id" uuid,
	"product_name" text,
	"accent_color" text,
	"logo_id" uuid,
	"icon_id" uuid,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "branding_accent_color" CHECK ("accent_color" ~ '^#[0-9a-f]{6}$')
);
--> statement-breakpoint
CREATE TABLE "iam"."email_changes" (
	"user_id" uuid PRIMARY KEY,
	"new_email" text NOT NULL,
	"token_hash" bytea NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "email_changes_new_email_lowercase" CHECK ("new_email" = lower("new_email"))
);
--> statement-breakpoint
CREATE TABLE "invitation_statuses" (
	"key" text PRIMARY KEY,
	"label" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invitations" (
	"id" uuid PRIMARY KEY,
	"email" text NOT NULL,
	"tenant_id" uuid,
	"role_id" uuid NOT NULL,
	"token_hash" bytea NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"is_active" boolean GENERATED ALWAYS AS (status = 'pending' and deleted_at is null) STORED,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"invited_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "invitations_email_lowercase" CHECK (email = lower(email))
);
--> statement-breakpoint
CREATE TABLE "iam"."known_devices" (
	"id" uuid PRIMARY KEY,
	"user_id" uuid NOT NULL,
	"browser_hash" bytea NOT NULL,
	"user_agent" text,
	"first_seen_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "modules" (
	"key" text PRIMARY KEY,
	"label" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "iam"."one_time_tokens" (
	"id" uuid PRIMARY KEY,
	"user_id" uuid,
	"type" text NOT NULL,
	"token_hash" bytea NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization" (
	"id" uuid PRIMARY KEY,
	"name" text NOT NULL,
	"email_checked_at" timestamp with time zone,
	"onboarding_dismissed_at" timestamp with time zone,
	"two_factor_policy" text DEFAULT 'off' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organization_two_factor_policy" CHECK ("two_factor_policy" in ('off', 'org_roles', 'everyone'))
);
--> statement-breakpoint
CREATE TABLE "outbox" (
	"id" uuid PRIMARY KEY,
	"kind" text NOT NULL,
	"recipient" text,
	"subject" text,
	"payload" bytea,
	"attempts" integer DEFAULT 0 NOT NULL,
	"run_after" timestamp with time zone DEFAULT now() NOT NULL,
	"locked_until" timestamp with time zone,
	"sent_at" timestamp with time zone,
	"failed_at" timestamp with time zone,
	"last_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "permissions" (
	"key" text PRIMARY KEY,
	"module_key" text NOT NULL,
	"action" text NOT NULL,
	"scope" text NOT NULL,
	"label" text NOT NULL,
	"description" text,
	"requires" text,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "profiles" (
	"id" uuid PRIMARY KEY,
	"name" text NOT NULL,
	"org_role_id" uuid,
	"preferences" jsonb DEFAULT '{}' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "project_statuses" (
	"key" text PRIMARY KEY,
	"label" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "projects" (
	"id" uuid PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "provider_settings" (
	"key" text PRIMARY KEY,
	"config" jsonb NOT NULL,
	"secret" bytea,
	"updated_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "iam"."rate_limits" (
	"key" text PRIMARY KEY,
	"count" integer NOT NULL,
	"window_start" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "iam"."recovery_codes" (
	"id" uuid PRIMARY KEY,
	"user_id" uuid NOT NULL,
	"code_hash" bytea NOT NULL,
	"used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "role_permissions" (
	"role_id" uuid,
	"permission_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "role_permissions_pkey" PRIMARY KEY("role_id","permission_key")
);
--> statement-breakpoint
CREATE TABLE "role_scopes" (
	"key" text PRIMARY KEY,
	"label" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "roles" (
	"id" uuid PRIMARY KEY,
	"key" text,
	"name" text NOT NULL,
	"description" text,
	"scope" text NOT NULL,
	"is_system" boolean DEFAULT false NOT NULL,
	"tenant_id" uuid,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "iam"."sessions" (
	"id" uuid PRIMARY KEY,
	"user_id" uuid NOT NULL,
	"device_public_key" jsonb NOT NULL,
	"refresh_hmac_key" bytea NOT NULL,
	"refresh_counter" bigint DEFAULT 0 NOT NULL,
	"refreshed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"not_after" timestamp with time zone NOT NULL,
	"auth_method" text DEFAULT 'password' NOT NULL,
	"sso_connection_id" uuid,
	"ip" inet,
	"user_agent" text,
	"revoked_at" timestamp with time zone,
	"revoked_reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sessions_auth_method" CHECK (auth_method in ('password', 'sso'))
);
--> statement-breakpoint
CREATE TABLE "iam"."sign_in_alerts" (
	"id" uuid PRIMARY KEY,
	"user_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"browser_hash" bytea,
	"user_agent" text,
	"ip" inet,
	"token_hash" bytea NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"reported_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "iam"."sign_in_challenges" (
	"id" uuid PRIMARY KEY,
	"user_id" uuid NOT NULL,
	"token_hash" bytea NOT NULL,
	"step" text NOT NULL,
	"device_key_hash" bytea NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sign_in_challenges_step" CHECK ("step" in ('verify', 'setup'))
);
--> statement-breakpoint
CREATE TABLE "iam"."signing_keys" (
	"kid" text PRIMARY KEY,
	"alg" text DEFAULT 'ES256' NOT NULL,
	"public_jwk" jsonb NOT NULL,
	"private_key" bytea NOT NULL,
	"activated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "iam"."sso_attempts" (
	"id" uuid PRIMARY KEY,
	"connection_id" uuid NOT NULL,
	"purpose" text NOT NULL,
	"state_hash" bytea NOT NULL,
	"nonce_hash" bytea NOT NULL,
	"code_verifier" bytea NOT NULL,
	"device_key_hash" bytea,
	"started_by" uuid,
	"expires_at" timestamp with time zone NOT NULL,
	"consumed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_attempts_purpose" CHECK ("purpose" in ('sign_in', 'test'))
);
--> statement-breakpoint
CREATE TABLE "iam"."sso_connections" (
	"id" uuid PRIMARY KEY,
	"name" text NOT NULL,
	"issuer" text NOT NULL,
	"client_id" text NOT NULL,
	"client_secret" bytea NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"tested_at" timestamp with time zone,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "iam"."sso_domains" (
	"domain" text PRIMARY KEY,
	"connection_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sso_domains_lowercase" CHECK ("domain" = lower("domain"))
);
--> statement-breakpoint
CREATE TABLE "iam"."sso_identities" (
	"id" uuid PRIMARY KEY,
	"connection_id" uuid NOT NULL,
	"subject" text NOT NULL,
	"user_id" uuid NOT NULL,
	"email" text NOT NULL,
	"last_sign_in_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenant_memberships" (
	"id" uuid PRIMARY KEY,
	"tenant_id" uuid NOT NULL,
	"user_id" uuid NOT NULL,
	"role_id" uuid NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "tenant_statuses" (
	"key" text PRIMARY KEY,
	"label" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY,
	"name" text NOT NULL,
	"status" text DEFAULT 'active' NOT NULL,
	"is_active" boolean GENERATED ALWAYS AS (status = 'active' and deleted_at is null) STORED,
	"is_main" boolean DEFAULT false NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "iam"."token_types" (
	"key" text PRIMARY KEY,
	"label" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "iam"."totp_factors" (
	"user_id" uuid PRIMARY KEY,
	"secret" bytea NOT NULL,
	"confirmed_at" timestamp with time zone,
	"last_used_step" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "iam"."user_statuses" (
	"key" text PRIMARY KEY,
	"label" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "iam"."users" (
	"id" uuid PRIMARY KEY,
	"email" text NOT NULL,
	"password_hash" text,
	"email_confirmed_at" timestamp with time zone,
	"status" text DEFAULT 'active' NOT NULL,
	"is_active" boolean GENERATED ALWAYS AS (status = 'active' and deleted_at is null) STORED,
	"last_login_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"deleted_at" timestamp with time zone,
	CONSTRAINT "users_email_lowercase" CHECK (email = lower(email))
);
--> statement-breakpoint
CREATE INDEX "audit_logs_tenant_time" ON "audit_logs" ("tenant_id","created_at");--> statement-breakpoint
CREATE INDEX "audit_logs_actor_time" ON "audit_logs" ("actor_user_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "branding_org" ON "branding" ((true)) WHERE tenant_id is null;--> statement-breakpoint
CREATE UNIQUE INDEX "branding_tenant" ON "branding" ("tenant_id") WHERE tenant_id is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "email_changes_hash" ON "iam"."email_changes" ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_token_hash" ON "invitations" ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "invitations_one_open" ON "invitations" ("email",coalesce("tenant_id", '00000000-0000-0000-0000-000000000000'::uuid)) WHERE status = 'pending' and deleted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "known_devices_user_browser" ON "iam"."known_devices" ("user_id","browser_hash");--> statement-breakpoint
CREATE INDEX "known_devices_last_seen" ON "iam"."known_devices" ("last_seen_at");--> statement-breakpoint
CREATE UNIQUE INDEX "one_time_tokens_hash" ON "iam"."one_time_tokens" ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "one_time_tokens_one_live" ON "iam"."one_time_tokens" ("user_id","type") WHERE consumed_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "organization_singleton" ON "organization" ((true));--> statement-breakpoint
CREATE INDEX "outbox_due" ON "outbox" ("run_after") WHERE sent_at is null and failed_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "projects_name_live" ON "projects" ("tenant_id",lower("name")) WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "projects_tenant_id" ON "projects" ("tenant_id");--> statement-breakpoint
CREATE UNIQUE INDEX "recovery_codes_hash" ON "iam"."recovery_codes" ("code_hash");--> statement-breakpoint
CREATE INDEX "recovery_codes_user_id" ON "iam"."recovery_codes" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "roles_key" ON "roles" ("key") WHERE key is not null;--> statement-breakpoint
CREATE UNIQUE INDEX "roles_name_live" ON "roles" (lower("name")) WHERE deleted_at is null and tenant_id is null;--> statement-breakpoint
CREATE INDEX "sessions_user_id" ON "iam"."sessions" ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_not_after" ON "iam"."sessions" ("not_after");--> statement-breakpoint
CREATE UNIQUE INDEX "sign_in_alerts_hash" ON "iam"."sign_in_alerts" ("token_hash");--> statement-breakpoint
CREATE INDEX "sign_in_alerts_user_id" ON "iam"."sign_in_alerts" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sign_in_challenges_hash" ON "iam"."sign_in_challenges" ("token_hash");--> statement-breakpoint
CREATE INDEX "sign_in_challenges_user_id" ON "iam"."sign_in_challenges" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "signing_keys_one_current" ON "iam"."signing_keys" ((true)) WHERE retired_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "sso_attempts_state" ON "iam"."sso_attempts" ("state_hash");--> statement-breakpoint
CREATE INDEX "sso_domains_connection_id" ON "iam"."sso_domains" ("connection_id");--> statement-breakpoint
CREATE UNIQUE INDEX "sso_identities_subject" ON "iam"."sso_identities" ("connection_id","subject");--> statement-breakpoint
CREATE INDEX "sso_identities_user_id" ON "iam"."sso_identities" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenant_memberships_live" ON "tenant_memberships" ("tenant_id","user_id") WHERE deleted_at is null;--> statement-breakpoint
CREATE INDEX "tenant_memberships_user_id" ON "tenant_memberships" ("user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_name_live" ON "tenants" (lower("name")) WHERE deleted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "tenants_one_main" ON "tenants" ((true)) WHERE is_main and deleted_at is null;--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_live" ON "iam"."users" ("email") WHERE deleted_at is null;--> statement-breakpoint
ALTER TABLE "brand_assets" ADD CONSTRAINT "brand_assets_created_by_profiles_id_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id");--> statement-breakpoint
ALTER TABLE "branding" ADD CONSTRAINT "branding_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id");--> statement-breakpoint
ALTER TABLE "branding" ADD CONSTRAINT "branding_logo_id_brand_assets_id_fkey" FOREIGN KEY ("logo_id") REFERENCES "brand_assets"("id");--> statement-breakpoint
ALTER TABLE "branding" ADD CONSTRAINT "branding_icon_id_brand_assets_id_fkey" FOREIGN KEY ("icon_id") REFERENCES "brand_assets"("id");--> statement-breakpoint
ALTER TABLE "branding" ADD CONSTRAINT "branding_updated_by_profiles_id_fkey" FOREIGN KEY ("updated_by") REFERENCES "profiles"("id");--> statement-breakpoint
ALTER TABLE "iam"."email_changes" ADD CONSTRAINT "email_changes_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "iam"."users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id");--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_role_id_roles_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id");--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_status_invitation_statuses_key_fkey" FOREIGN KEY ("status") REFERENCES "invitation_statuses"("key");--> statement-breakpoint
ALTER TABLE "invitations" ADD CONSTRAINT "invitations_invited_by_profiles_id_fkey" FOREIGN KEY ("invited_by") REFERENCES "profiles"("id");--> statement-breakpoint
ALTER TABLE "iam"."known_devices" ADD CONSTRAINT "known_devices_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "iam"."users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "iam"."one_time_tokens" ADD CONSTRAINT "one_time_tokens_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "iam"."users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "iam"."one_time_tokens" ADD CONSTRAINT "one_time_tokens_type_token_types_key_fkey" FOREIGN KEY ("type") REFERENCES "iam"."token_types"("key");--> statement-breakpoint
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_module_key_modules_key_fkey" FOREIGN KEY ("module_key") REFERENCES "modules"("key");--> statement-breakpoint
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_scope_role_scopes_key_fkey" FOREIGN KEY ("scope") REFERENCES "role_scopes"("key");--> statement-breakpoint
ALTER TABLE "permissions" ADD CONSTRAINT "permissions_requires_permissions_key_fkey" FOREIGN KEY ("requires") REFERENCES "permissions"("key");--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_id_users_id_fkey" FOREIGN KEY ("id") REFERENCES "iam"."users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "profiles" ADD CONSTRAINT "profiles_org_role_id_roles_id_fkey" FOREIGN KEY ("org_role_id") REFERENCES "roles"("id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_status_project_statuses_key_fkey" FOREIGN KEY ("status") REFERENCES "project_statuses"("key");--> statement-breakpoint
ALTER TABLE "projects" ADD CONSTRAINT "projects_created_by_profiles_id_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id");--> statement-breakpoint
ALTER TABLE "provider_settings" ADD CONSTRAINT "provider_settings_updated_by_profiles_id_fkey" FOREIGN KEY ("updated_by") REFERENCES "profiles"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "iam"."recovery_codes" ADD CONSTRAINT "recovery_codes_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "iam"."users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_roles_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_key_permissions_key_fkey" FOREIGN KEY ("permission_key") REFERENCES "permissions"("key") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_scope_role_scopes_key_fkey" FOREIGN KEY ("scope") REFERENCES "role_scopes"("key");--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id");--> statement-breakpoint
ALTER TABLE "roles" ADD CONSTRAINT "roles_created_by_profiles_id_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id");--> statement-breakpoint
ALTER TABLE "iam"."sessions" ADD CONSTRAINT "sessions_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "iam"."users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "iam"."sessions" ADD CONSTRAINT "sessions_sso_connection_id_sso_connections_id_fkey" FOREIGN KEY ("sso_connection_id") REFERENCES "iam"."sso_connections"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "iam"."sign_in_alerts" ADD CONSTRAINT "sign_in_alerts_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "iam"."users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "iam"."sign_in_alerts" ADD CONSTRAINT "sign_in_alerts_session_id_sessions_id_fkey" FOREIGN KEY ("session_id") REFERENCES "iam"."sessions"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "iam"."sign_in_challenges" ADD CONSTRAINT "sign_in_challenges_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "iam"."users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "iam"."sso_attempts" ADD CONSTRAINT "sso_attempts_connection_id_sso_connections_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "iam"."sso_connections"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "iam"."sso_attempts" ADD CONSTRAINT "sso_attempts_started_by_users_id_fkey" FOREIGN KEY ("started_by") REFERENCES "iam"."users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "iam"."sso_connections" ADD CONSTRAINT "sso_connections_created_by_users_id_fkey" FOREIGN KEY ("created_by") REFERENCES "iam"."users"("id") ON DELETE SET NULL;--> statement-breakpoint
ALTER TABLE "iam"."sso_domains" ADD CONSTRAINT "sso_domains_connection_id_sso_connections_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "iam"."sso_connections"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "iam"."sso_identities" ADD CONSTRAINT "sso_identities_connection_id_sso_connections_id_fkey" FOREIGN KEY ("connection_id") REFERENCES "iam"."sso_connections"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "iam"."sso_identities" ADD CONSTRAINT "sso_identities_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "iam"."users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_tenant_id_tenants_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id");--> statement-breakpoint
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_user_id_profiles_id_fkey" FOREIGN KEY ("user_id") REFERENCES "profiles"("id");--> statement-breakpoint
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_role_id_roles_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id");--> statement-breakpoint
ALTER TABLE "tenant_memberships" ADD CONSTRAINT "tenant_memberships_created_by_profiles_id_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id");--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_status_tenant_statuses_key_fkey" FOREIGN KEY ("status") REFERENCES "tenant_statuses"("key");--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_created_by_profiles_id_fkey" FOREIGN KEY ("created_by") REFERENCES "profiles"("id");--> statement-breakpoint
ALTER TABLE "iam"."totp_factors" ADD CONSTRAINT "totp_factors_user_id_users_id_fkey" FOREIGN KEY ("user_id") REFERENCES "iam"."users"("id") ON DELETE CASCADE;--> statement-breakpoint
ALTER TABLE "iam"."users" ADD CONSTRAINT "users_status_user_statuses_key_fkey" FOREIGN KEY ("status") REFERENCES "iam"."user_statuses"("key");
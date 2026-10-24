export type Mode = "web" | "desktop" | "ios" | "dev";

export type EnvStatus =
  | "publishing"
  | "warm"
  | "serving"
  | "expired"
  | "cold"
  | "unhealthy"
  | "crashed"
  | "stopped";

export interface Liveness {
  state: "serving" | "unhealthy" | "crashed";
  reason: "port_open" | "process_alive" | "port_unresponsive" | "process_exited";
  checked_at: string;
  pid_alive: boolean;
  port_open: boolean | null;
}

export interface WebRecipe {
  serve: string;
  build?: string;
  requires?: string[];
  readyPath: string;
  readyTimeoutMs: number;
  env: Record<string, string>;
}

export interface DesktopRecipe {
  pack: string;
  kind: "electron" | "native";
  embedUrl?: string;
}

export interface DevRecipe {
  run: string;
  kind: "electron";
  warm?: string;
  readyTimeoutMs: number;
}

export interface IosRecipe {
  pack: string;
  bundleId: string;
  device: string;
  runtime: string;
  stream: boolean;
  readyTimeoutMs: number;
}

export interface PostgresDepRecipe {
  kind: "postgres";
  image: string;
  env: string;
  database: string;
  user: string;
  provider?: PostgresProvider;
}

export type PostgresProvider = "docker" | "local";

export interface SqliteDepRecipe {
  kind: "sqlite";
  path: string;
  env: string;
}

export type DepRecipe = PostgresDepRecipe | SqliteDepRecipe;

export interface ScenarioRecipe {
  seed?: string;
  default: boolean;
}

export interface Recipe {
  name: string;
  source: "nectar.toml" | "package.json" | "requirements.txt" | "pyproject.toml" | "Gemfile" | "static";
  detected?: { stack: string; reason: string };
  web?: WebRecipe;
  desktop?: DesktopRecipe;
  ios?: IosRecipe;
  dev?: DevRecipe;
  deps?: Record<string, DepRecipe>;
  scenarios?: Record<string, ScenarioRecipe>;
}

export interface DepRecord {
  kind: "postgres" | "sqlite";
  env: string;
  created_at: string;
  image?: string;
  provider?: PostgresProvider;
  major?: number;
  project?: string;
  port?: number;
  database?: string;
  user?: string;
  file?: string;
}

export interface ServeRecord {
  cmd: string;
  pid: number;
  pgid: number;
  upstream_port?: number;
  upstream_host?: string;
  tailnet_port?: number;
  proxy_port?: number;
  started_at?: string;
}

export interface DevRecord {
  run: string;
  kind: "electron";
  ready_timeout_ms: number;
  warm_hash?: string;
}

export interface EnvUrls {
  local: string | null;
  mesh: string | null;
  public?: string | null;
}

// One configured internet-exposure destination (machine config `exposures.<name>`).
// v0.2 ships the `relay` kind (the nctr.site relay, D21); other kinds are schema slots.
export interface ExposureTarget {
  kind: "relay" | "ssh-tunnel" | "exe-dev" | "vercel-deploy";
  host?: string; // relay/ssh-tunnel: the VM nectar drives to run nectar-relay
  user?: string; // ssh user on that VM (default: root)
  domain?: string; // relay: the wildcard domain, e.g. "nctr.site"
  gate?: "password" | "none"; // default gate for this target
  // How nectar reaches the relay. "relayd" talks to nectar-relayd's control port on the
  // relay's tailnet address (D35). The others run nectar-relay over Tailscale SSH (the
  // default) or the system ssh client, and stay only for relays without relayd.
  control?: "tailscale-ssh" | "ssh" | "relayd";
  port?: number; // relayd: the control port (default 8450)
  default?: boolean; // the target `publish --public` uses
}

// What an env currently has exposed (on the env record, for unexpose/gc/resolve).
export interface ExposureRecord {
  target: string; // the exposures.<name> key
  kind: string;
  sub: string; // the subdomain label on the relay
  url: string; // https://<sub>.<domain>
  gate: "password" | "none";
  expires_at: string;
  control?: "relayd";
  fixed_ttl?: boolean;
  cap_at?: string;
  revoked_at?: string;
  revoked_reason?: string;
}

export interface PublishFailure {
  code: string;
  message: string;
  failed_at: string;
  log_tail: string[];
  cleanup_errors?: string[];
}

export interface Publisher {
  hive_bee?: string;
  hive_session?: string;
  user: string;
  cell?: string;
  via?: "nectard" | "tailnet";
  node?: string;
  node_name?: string;
  login?: string;
}

export interface TestpackManifest {
  testpack: 1;
  app: string;
  branch: string;
  commit: string;
  platform: string;
  kind: "electron" | "native" | "ios-sim";
  entry: string;
  bundle_id?: string;
  embed?: {
    mode: "webview";
    url: string;
  };
  built_at: string;
  built_by: {
    hive_bee?: string;
    hive_session?: string;
    host: string;
  };
}

export interface TestpackRecord {
  file: string;
  sha256: string;
  size_bytes: number;
  platform: string;
  entry: string;
  url: string | null;
  bundle_id?: string;
}

export type BranchSource = "flag" | "head" | "contains" | "session" | "detached";

export interface EnvRecord {
  eid: string;
  name: string;
  mode: Mode;
  app: string;
  repo: string;
  branch: string;
  branch_source?: BranchSource;
  commit: string;
  origin?: string;
  roots?: string[];
  worktree: string;
  borrowed_worktree: boolean;
  status: EnvStatus;
  serve?: ServeRecord;
  liveness?: Liveness;
  dev?: DevRecord;
  pinned?: boolean;
  owner_inactive_since?: string;
  last_opened_at?: string;
  sim_udid?: string;
  sim_device?: string;
  urls: EnvUrls;
  ref: string;
  published_at: string;
  expires_at: string;
  last_touched_at: string;
  ttl_ms?: number;
  publisher: Publisher;
  packet_hint?: string;
  evidence: string[];
  install_hash?: string;
  testpack?: TestpackRecord;
  failure?: PublishFailure;
  exposure?: ExposureRecord;
  deps?: Record<string, DepRecord>;
}

export interface MachineConfig {
  upstream_port_start: number;
  upstream_port_end: number;
  tailnet_port_start: number;
  tailnet_port_end: number;
  serving_web_limit: number;
  serving_sim_limit: number;
  idle_stop_ms: number;
  worktree_cache_allowlist: string[];
  pack_quota_bytes: number;
  evidence_quota_bytes: number;
  log_max_bytes: number;
  pack_server_port: number;
  pack_server_pid?: number;
  pack_server_pgid?: number;
  tailnet_host?: string;
  tailnet_dns_name?: string;
  last_gc_at?: string;
  exposures?: Record<string, ExposureTarget>;
  daemon?: "disabled";
  remote?: RemoteConfig;
  pool?: PoolConfig;
}

export type PoolCategory = "web" | "static";

export type PoolPolicy = "first-healthy" | "least-loaded";

export interface PoolConfig {
  hosts?: string[];
  default_for?: PoolCategory[];
  prefer?: PoolPolicy;
}

export interface RemoteAllow {
  node_id?: string;
  login?: string;
}

export interface RemoteConfig {
  listen?: boolean;
  allow?: RemoteAllow[];
  ssh_fallback?: boolean;
}

export interface ResolveResult {
  env: string;
  ref: string;
  mode: Mode;
  commit: string;
  current_commit: string | null;
  stale: boolean;
  is_self: boolean;
  urls: EnvUrls;
  testpack_url: string | null;
  sha256: string | null;
  size_bytes: number | null;
  platform: string | null;
  entry: string | null;
  bundle_id: string | null;
  ax_url: string | null;
  host: string;
  status: EnvStatus;
  liveness: Liveness | null;
  packet_fields: PacketFields;
  expires_at: string | null;
  expires_in: string | null;
  log_tail?: string[];
  touched?: false;
  touch_skipped?: string;
  preview_url_reason?: string;
}

export interface MultiResolveResult {
  env: string;
  host: string;
  is_self: boolean;
  resolutions: ResolveResult[];
}

export interface PacketFields {
  preview_url: string | null;
  testpack_ref: string | null;
  dev_ref: string | null;
  shell_recipe: string | null;
  public_url: string | null;
}

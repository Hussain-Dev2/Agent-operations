import type { Config } from "./config.js";
import type { Db } from "./db/index.js";
import type { SecretBox } from "./lib/crypto.js";
import type { AgentRegistry } from "./services/agents.js";
import type { Audit } from "./services/audit.js";
import type { AuthService, SessionInfo } from "./services/auth.js";
import type { DashboardBus } from "./services/dashboardBus.js";
import type { DeviceService } from "./services/devices.js";
import type { ScreenRelay, TerminalRelay } from "./services/relays.js";

export interface Hub {
  config: Config;
  db: Db;
  box: SecretBox;
  hubPublicKey: string;
  audit: Audit;
  auth: AuthService;
  devices: DeviceService;
  agents: AgentRegistry;
  bus: DashboardBus;
  screens: ScreenRelay;
  terminals: TerminalRelay;
}

declare module "fastify" {
  interface FastifyRequest {
    session: SessionInfo | null;
  }
}

import type { HubToDashboard } from "@operator/shared";

type Listener = (message: HubToDashboard) => void;

/** Fan-out of live events to connected dashboards. */
export class DashboardBus {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  publish(message: HubToDashboard): void {
    for (const listener of this.listeners) listener(message);
  }
}

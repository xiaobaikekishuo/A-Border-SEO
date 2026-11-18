import { AsyncLocalStorage } from "node:async_hooks";
import type { HostedSnapshot } from "./control";
export type HostedContext = { userId: string; deviceId: string; snapshot: HostedSnapshot };
const holder = globalThis as unknown as { hostedContext?: AsyncLocalStorage<HostedContext> };
export const hostedContext = holder.hostedContext ??= new AsyncLocalStorage<HostedContext>();

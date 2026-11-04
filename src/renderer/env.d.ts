import type { FlowraAPI } from "../shared/types";
declare global {
  interface Window {
    flowra: FlowraAPI;
  }
}

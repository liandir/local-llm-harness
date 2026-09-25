import type { FeatureRuntime } from "../../build/contracts.js";
import { readSettings } from "../../config/settings.js";
import { searchRequest, searchSearxng, searchUrl } from "./searxng.js";
export function createSearchFeature(): FeatureRuntime {
  const approvedDestinations = new WeakMap<Record<string, unknown>, string>();
  return {
    tools: ["web_search"], category: () => "search", needsApproval: () => true,
    async prepare(_name, args, settings) {
      searchRequest(args);
      const endpoint = settings.webSearchEndpoint ?? "";
      await searchUrl(endpoint);
      const previous = approvedDestinations.get(args);
      if (previous !== undefined && previous !== endpoint) throw new Error("Search destination changed while approval was pending. Request a new search.");
      approvedDestinations.set(args, endpoint);
      return {};
    },
    async execute(_name, args, _id, signal) {
      const request = searchRequest(args);
      const endpoint = readSettings().webSearchEndpoint ?? "";
      if (approvedDestinations.get(args) !== endpoint) throw new Error("Search destination is no longer approved.");
      const results = await searchSearxng(endpoint, request, signal);
      return { result: JSON.stringify({ query: request.query, results }) };
    }
  };
}

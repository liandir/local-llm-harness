import { createFeatures as commands } from "../commands/full/runtime.js";
import { createSearchFeature } from "../webSearch/runtime.js";
import type { FeatureContext } from "../../build/contracts.js";
export function createFeatures(context: FeatureContext) { return [...commands(context), createSearchFeature()]; }

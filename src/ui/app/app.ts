/**
 * Peak UI bundle entry — registers all web components and applies the saved
 * theme. Every page (dashboard.html, tasks.html, preview.html) loads this one
 * bundle; each page's shell contains only its own element.
 */
import { applySavedTheme } from "./tokens.js";
import "./dashboard-app.js";
import "./tasks-app.js";
import "./preview-app.js";

applySavedTheme();

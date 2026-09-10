// StayQuiet UI — ambient declarations for stylesheet side-effect imports.
// main.tsx imports three .css files for their global side effects (tokens, theme,
// app styles). Vite resolves those at build time, but `tsc --noEmit` needs a shape;
// without this file every CSS import is a TS2882 error. Added as file 11 of DP-UI
// (amendment 2026-09-10): the plan's ten-file list predates the repo's
// `"include": ["src"]` tsconfig, under which the pre-existing examples/ exemption
// does not apply to src/stayquiet/web/.
declare module "*.css";

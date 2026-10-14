/// <reference types="vite/client" />
declare const __BUILD_REVISION__: string | null;
declare const __BUILD_TIME__: string | null;
interface ImportMetaEnv {
  readonly VITE_BUILD_TIME: string;
}

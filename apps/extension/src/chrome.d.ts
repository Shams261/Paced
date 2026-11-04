// Minimal ambient types for the extension APIs this code uses; no runtime dependency.
declare namespace chrome.runtime {
  const id: string;
  function sendMessage(message: unknown): Promise<unknown>;
  const onMessage: {
    addListener(
      listener: (
        message: never,
        sender: { id?: string },
        respond: (value: unknown) => void,
      ) => boolean | void,
    ): void;
  };
}
declare namespace chrome.storage {
  interface Area {
    get(keys: null | string | string[]): Promise<Record<string, unknown>>;
    set(items: Record<string, unknown>): Promise<void>;
    remove(keys: string | string[]): Promise<void>;
    clear(): Promise<void>;
  }
  const local: Area;
  const session: Area;
}

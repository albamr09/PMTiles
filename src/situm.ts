import SitumSDK from "@situm/sdk-js";
import { FetchSource, type Source } from "pmtiles";
import { createRoot, createSignal } from "solid-js";

const STORAGE_KEY = "pmtiles-viewer-situm-api-key";

export function isSitumUrl(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith("situm.com");
  } catch {
    return false;
  }
}

const situmState = createRoot(() => {
  const stored =
    typeof localStorage !== "undefined"
      ? localStorage.getItem(STORAGE_KEY)
      : null;
  const [apiKey, setApiKeySignal] = createSignal(stored ?? "");

  let sdk: SitumSDK | undefined;
  let sdkKey: string | undefined;

  const getSdk = (): SitumSDK | undefined => {
    const key = apiKey().trim();
    if (!key) {
      if (sdk) {
        sdk.dispose();
        sdk = undefined;
        sdkKey = undefined;
      }
      return undefined;
    }
    if (sdkKey !== key) {
      sdk?.dispose();
      sdk = new SitumSDK({ auth: { apiKey: key } });
      sdkKey = key;
    }
    return sdk;
  };

  const setApiKey = (key: string) => {
    localStorage.setItem(STORAGE_KEY, key);
    setApiKeySignal(key);
    if (sdkKey !== key.trim()) {
      sdk?.dispose();
      sdk = undefined;
      sdkKey = undefined;
    }
  };

  const clearApiKey = () => {
    localStorage.removeItem(STORAGE_KEY);
    setApiKeySignal("");
    sdk?.dispose();
    sdk = undefined;
    sdkKey = undefined;
  };

  return { apiKey, setApiKey, clearApiKey, getSdk };
});

export const situmApiKey = situmState.apiKey;
export const setSitumApiKey = situmState.setApiKey;
export const clearSitumApiKey = situmState.clearApiKey;
export const getSitumSdk = situmState.getSdk;

export async function getSitumJwt(): Promise<string> {
  const sdk = getSitumSdk();
  if (!sdk) {
    throw new Error(
      "Situm API key is required for tiles on situm.com. Use “Situm API key” in the toolbar.",
    );
  }
  return sdk.getValidJwt();
}

export class SitumFetchSource implements Source {
  private fetchSource: FetchSource;

  constructor(url: string) {
    this.fetchSource = new FetchSource(url);
  }

  getKey() {
    return this.fetchSource.getKey();
  }

  async getBytes(
    offset: number,
    length: number,
    signal?: AbortSignal,
    etag?: string,
  ) {
    const jwt = await getSitumJwt();
    this.fetchSource.setHeaders(
      new Headers({ Authorization: `Bearer ${jwt}` }),
    );
    return this.fetchSource.getBytes(offset, length, signal, etag);
  }
}

export async function situmFetch(
  url: string,
  init?: RequestInit,
): Promise<Response> {
  const jwt = await getSitumJwt();
  const headers = new Headers(init?.headers);
  headers.set("Authorization", `Bearer ${jwt}`);
  return fetch(url, { ...init, headers });
}

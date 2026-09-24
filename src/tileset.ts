// a TileJSON or a .pmtiles archive, local or remote
// gets metadata, tiles, etc

import { FileSource, PMTiles, TileType } from "pmtiles";
import { SitumFetchSource, getSitumSdk, isSitumUrl, situmFetch } from "./situm";

type TileRequest = (url: string, init?: RequestInit) => Promise<Response>;

interface VectorLayer {
  id: string;
}

interface Metadata {
  type?: string;
  vector_layers: VectorLayer[];
}

export type MaplibreTilesetSource =
  | {
      type: "vector";
      url?: string;
      tiles?: string[];
      minzoom?: number;
      maxzoom?: number;
      bounds?: [number, number, number, number];
      encoding?: "mvt" | "mlt";
    }
  | {
      type: "raster";
      url?: string;
      tiles?: string[];
      minzoom?: number;
      maxzoom?: number;
      bounds?: [number, number, number, number];
    };

async function maplibreSourceForPmtiles(
  tileset: PMTilesTileset & Pick<Tileset, "getMaplibreSourceUrl">,
): Promise<MaplibreTilesetSource> {
  if (await tileset.isVector()) {
    return {
      type: "vector",
      url: tileset.getMaplibreSourceUrl(),
      encoding: await tileset.getVectorEncoding(),
    };
  }
  return {
    type: "raster",
    url: tileset.getMaplibreSourceUrl(),
  };
}

export interface Tileset {
  getZxy(z: number, x: number, y: number): Promise<ArrayBuffer | undefined>;
  getMetadata(): Promise<Metadata>;
  getStateUrl(): string | undefined;
  getLocalFileName(): string;
  getMaplibreSourceUrl(): string;
  getMaplibreSource(): Promise<MaplibreTilesetSource>;
  getBounds(): Promise<[number, number, number, number]>;
  getMaxZoom(): Promise<number>;

  getVectorLayers(): Promise<string[]>;
  getVectorEncoding(): Promise<"mvt" | "mlt" | undefined>;
  isOverlay(): Promise<boolean>;
  isVector(): Promise<boolean>;

  test(): Promise<void>;

  archiveForProtocol(): PMTiles | undefined;
  requiresSitumAuth(): boolean;
}

export class PMTilesTileset {
  archive: PMTiles;

  constructor(p: PMTiles) {
    this.archive = p;
  }

  async getZxy(z: number, x: number, y: number) {
    const resp = await this.archive.getZxy(z, x, y);
    if (resp) return resp.data;
  }

  async getBounds(): Promise<[number, number, number, number]> {
    const h = await this.getHeader();
    return [h.minLon, h.minLat, h.maxLon, h.maxLat];
  }

  async getMaxZoom(): Promise<number> {
    const h = await this.getHeader();
    return h.maxZoom;
  }

  async isVector() {
    const h = await this.getHeader();
    return h.tileType === TileType.Mvt || h.tileType === TileType.Mlt;
  }

  async getHeader() {
    return await this.archive.getHeader();
  }

  async test() {
    await this.archive.getHeader();
  }

  async getMetadata() {
    return (await this.archive.getMetadata()) as Metadata;
  }

  async isOverlay() {
    const m = await this.getMetadata();
    return m.type === "overlay";
  }

  async getVectorLayers() {
    const m = await this.getMetadata();
    return m.vector_layers.map((l) => l.id);
  }

  async getVectorEncoding() {
    const h = await this.getHeader();
    if (h.tileType === TileType.Mvt) return "mvt";
    if (h.tileType === TileType.Mlt) return "mlt";
    return undefined;
  }
}

class RemotePMTilesTileset extends PMTilesTileset implements Tileset {
  url: string;

  constructor(url: string) {
    super(new PMTiles(url));
    this.url = url;
  }

  getStateUrl() {
    return this.url;
  }

  getLocalFileName() {
    return "";
  }

  getMaplibreSourceUrl() {
    return `pmtiles://${this.url}`;
  }

  archiveForProtocol() {
    return undefined;
  }

  requiresSitumAuth() {
    return false;
  }

  getMaplibreSource() {
    return maplibreSourceForPmtiles(this);
  }
}

class SitumRemotePMTilesTileset extends PMTilesTileset implements Tileset {
  url: string;

  constructor(url: string) {
    super(new PMTiles(new SitumFetchSource(url)));
    this.url = url;
  }

  getStateUrl() {
    return this.url;
  }

  getLocalFileName() {
    return "";
  }

  getMaplibreSourceUrl() {
    return `pmtiles://${this.url}`;
  }

  archiveForProtocol() {
    return this.archive;
  }

  requiresSitumAuth() {
    return true;
  }

  async test() {
    if (!getSitumSdk()) {
      throw new Error(
        "Situm API key is required for tiles on situm.com. Use “Situm API key” in the toolbar.",
      );
    }
    await this.archive.getHeader();
  }

  getMaplibreSource() {
    return maplibreSourceForPmtiles(this);
  }
}

class LocalPMTilesTileset extends PMTilesTileset implements Tileset {
  name: string;

  constructor(file: File) {
    super(new PMTiles(new FileSource(file)));
    this.name = file.name;
  }

  // the local file cannot be persisted in the URL.
  getStateUrl() {
    return undefined;
  }

  getLocalFileName() {
    return this.name;
  }

  getMaplibreSourceUrl() {
    return `pmtiles://${this.name}`;
  }

  archiveForProtocol() {
    return this.archive;
  }

  requiresSitumAuth() {
    return false;
  }

  getMaplibreSource() {
    return maplibreSourceForPmtiles(this);
  }
}

interface TileJSONDocument {
  bounds?: [number, number, number, number];
  minzoom?: number;
  maxzoom?: number;
  tiles: string[];
  vector_layers?: VectorLayer[];
  type?: string;
}

class TileJSONTileset implements Tileset {
  url: string;
  private request: TileRequest;
  private situm: boolean;
  private tileJsonPromise?: Promise<TileJSONDocument>;

  constructor(url: string, request: TileRequest = fetch, situm = false) {
    this.url = url;
    this.request = request;
    this.situm = situm;
  }

  private getTileJson(): Promise<TileJSONDocument> {
    if (!this.tileJsonPromise) {
      this.tileJsonPromise = this.request(this.url).then((resp) => resp.json());
    }
    return this.tileJsonPromise;
  }

  archiveForProtocol() {
    return undefined;
  }

  requiresSitumAuth() {
    return this.situm;
  }

  async test() {
    if (this.situm && !getSitumSdk()) {
      throw new Error(
        "Situm API key is required for tiles on situm.com. Use “Situm API key” in the toolbar.",
      );
    }
    await this.getTileJson();
  }

  async getBounds() {
    const j = await this.getTileJson();
    return j.bounds as [number, number, number, number];
  }

  async getMaxZoom() {
    const j = await this.getTileJson();
    return j.maxzoom!;
  }

  getMaplibreSourceUrl() {
    return this.url;
  }

  async getMaplibreSource(): Promise<MaplibreTilesetSource> {
    const j = await this.getTileJson();
    const shared = {
      tiles: j.tiles,
      minzoom: j.minzoom,
      maxzoom: j.maxzoom,
      bounds: j.bounds,
    };
    if (await this.isVector()) {
      return {
        type: "vector",
        ...shared,
        encoding: await this.getVectorEncoding(),
      };
    }
    return { type: "raster", ...shared };
  }

  async isOverlay() {
    return true;
  }

  async isVector() {
    const j = await this.getTileJson();
    const template = j.tiles[0];
    const pathname = new URL(template).pathname;
    return (
      pathname.endsWith(".pbf") ||
      pathname.endsWith(".mvt") ||
      pathname.endsWith(".mlt")
    );
  }

  getStateUrl() {
    return this.url;
  }

  getLocalFileName() {
    return "";
  }

  async getZxy(z: number, x: number, y: number) {
    const j = await this.getTileJson();
    const template = j.tiles[0];
    const tileURL = template
      .replace("{z}", z)
      .replace("{x}", x)
      .replace("{y}", y);
    const tileResp = await this.request(tileURL);
    return await tileResp.arrayBuffer();
  }

  async getMetadata() {
    return (await this.getTileJson()) as Metadata;
  }

  async getVectorLayers() {
    const metadata = await this.getTileJson();
    return metadata.vector_layers!.map((l) => l.id);
  }

  async getVectorEncoding() {
    const j = await this.getTileJson();
    const template = j.tiles[0];
    const pathname = new URL(template).pathname;
    if (pathname.endsWith(".mlt")) return "mlt";
    return "mvt";
  }
}

// from a input box or a URL param state.
export const tilesetFromString = (url: string): Tileset => {
  const parsed = new URL(url);
  const situm = isSitumUrl(url);
  if (parsed.pathname.endsWith(".json")) {
    if (situm) {
      return new TileJSONTileset(url, situmFetch, true);
    }
    return new TileJSONTileset(url);
  }
  if (situm) {
    return new SitumRemotePMTilesTileset(url);
  }
  return new RemotePMTilesTileset(url);
};

export const tilesetFromFile = (file: File): Tileset => {
  return new LocalPMTilesTileset(file);
};

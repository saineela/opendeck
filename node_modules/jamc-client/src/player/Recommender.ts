import type { Track } from "../datasource/types";

export class Recommender {
  async getRecommendations(_seed: Track): Promise<Track[]> {
    return [];
  }
}


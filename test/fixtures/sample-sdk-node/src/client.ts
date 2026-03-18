/* eslint-disable no-unused-vars */
import type { WorkOSOptions, Organization, ListResponse } from './models.js';

export class WorkOSClient {
  readonly baseURL: string;
  private readonly apiKey: string;

  constructor(options: WorkOSOptions) {
    this.apiKey = options.apiKey;
    this.baseURL = options.baseUrl ?? 'https://api.workos.com';
  }

  async getOrganization(id: string): Promise<Organization> {
    throw new Error('Not implemented');
  }

  async listOrganizations(limit?: number): Promise<ListResponse<Organization>> {
    throw new Error('Not implemented');
  }

  async deleteOrganization(id: string): Promise<void> {
    throw new Error('Not implemented');
  }
}

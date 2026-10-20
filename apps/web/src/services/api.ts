import { HealthCheckResponse } from "@connectsphere/shared";

const API_BASE_URL = import.meta.env.VITE_API_URL || "http://localhost:4000";

export class ApiClient {
  static async getLiveness(): Promise<HealthCheckResponse> {
    const response = await fetch(`${API_BASE_URL}/health/live`);
    if (!response.ok) {
      throw new Error(`Liveness check failed with HTTP ${response.status}`);
    }
    return response.json();
  }

  static async getReadiness(): Promise<{ report: HealthCheckResponse; status: number }> {
    const response = await fetch(`${API_BASE_URL}/health/ready`);
    const data = await response.json();
    return {
      report: data as HealthCheckResponse,
      status: response.status,
    };
  }
}

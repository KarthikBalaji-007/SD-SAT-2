import { useEffect, useState } from "react";
import { ApiClient } from "./services/api";
import { HealthCheckResponse } from "@connectsphere/shared";

interface HealthState {
  loading: boolean;
  live: HealthCheckResponse | null;
  ready: { report: HealthCheckResponse; status: number } | null;
  error: string | null;
  lastChecked: Date | null;
}

export function App() {
  const [health, setHealth] = useState<HealthState>({
    loading: true,
    live: null,
    ready: null,
    error: null,
    lastChecked: null,
  });

  const checkConnectivity = async () => {
    setHealth((prev) => ({ ...prev, loading: true, error: null }));
    try {
      const liveData = await ApiClient.getLiveness();
      const readyData = await ApiClient.getReadiness();
      setHealth({
        loading: false,
        live: liveData,
        ready: readyData,
        error: null,
        lastChecked: new Date(),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : "Failed to connect to API server";
      setHealth({
        loading: false,
        live: null,
        ready: null,
        error: msg,
        lastChecked: new Date(),
      });
    }
  };

  useEffect(() => {
    checkConnectivity();
  }, []);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 flex flex-col justify-between">
      {/* Header */}
      <header className="border-b border-slate-800 bg-slate-900/60 backdrop-blur px-6 py-4">
        <div className="max-w-6xl mx-auto flex items-center justify-between">
          <div className="flex items-center space-x-3">
            <div className="w-8 h-8 rounded-lg bg-indigo-600 flex items-center justify-center font-bold text-white shadow-lg shadow-indigo-500/20">
              C
            </div>
            <h1 className="text-xl font-bold tracking-tight text-white">ConnectSphere</h1>
          </div>
          <div className="text-xs text-slate-400 bg-slate-800/80 px-3 py-1 rounded-full border border-slate-700">
            Phase 1 Foundation
          </div>
        </div>
      </header>

      {/* Hero & Platform Landing */}
      <main className="max-w-6xl mx-auto px-6 py-12 flex-1 w-full flex flex-col justify-center">
        <div className="text-center max-w-2xl mx-auto mb-12">
          <h2 className="text-4xl font-extrabold tracking-tight text-white sm:text-5xl mb-4">
            ConnectSphere
          </h2>
          <p className="text-lg text-slate-400">
            A social networking and messaging platform engineered with polyglot persistence,
            asynchronous RabbitMQ event streaming, and real-time Socket.IO communication.
          </p>
        </div>

        {/* API Health & Infrastructure Diagnostics */}
        <div className="max-w-2xl mx-auto w-full bg-slate-900 border border-slate-800 rounded-xl p-6 shadow-xl">
          <div className="flex items-center justify-between mb-4 pb-3 border-b border-slate-800">
            <div>
              <h3 className="text-base font-semibold text-white">System Connectivity & Health</h3>
              <p className="text-xs text-slate-400">Probing Express API at /health/live &amp; /health/ready</p>
            </div>
            <button
              onClick={checkConnectivity}
              disabled={health.loading}
              className="text-xs bg-indigo-600 hover:bg-indigo-500 disabled:opacity-50 text-white px-3 py-1.5 rounded-md transition"
            >
              {health.loading ? "Probing..." : "Refresh"}
            </button>
          </div>

          {/* Loading State */}
          {health.loading && (
            <div className="flex items-center justify-center py-8 text-slate-400 space-x-2">
              <svg className="animate-spin h-5 w-5 text-indigo-400" xmlns="http://www.w3.org/2000/svg" fill="none" viewBox="0 0 24 24">
                <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4"></circle>
                <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8v8H4z"></path>
              </svg>
              <span className="text-sm">Connecting to API server...</span>
            </div>
          )}

          {/* Error State */}
          {!health.loading && health.error && (
            <div className="p-4 rounded-lg bg-rose-950/40 border border-rose-800 text-rose-200 text-sm">
              <div className="font-medium mb-1 flex items-center space-x-1.5">
                <span>⚠️ Connection Unavailable</span>
              </div>
              <p className="text-xs text-rose-300 mb-2">{health.error}</p>
              <p className="text-xs text-slate-400">
                Ensure the backend API server is running on port 4000.
              </p>
            </div>
          )}

          {/* Active Health Display */}
          {!health.loading && !health.error && health.live && (
            <div className="space-y-4">
              <div className="flex items-center justify-between text-sm bg-slate-800/40 p-3 rounded-lg border border-slate-800">
                <span className="text-slate-300">API Process Liveness</span>
                <span className="inline-flex items-center px-2 py-0.5 rounded text-xs font-medium bg-emerald-950 text-emerald-400 border border-emerald-800">
                  ● Healthy (Uptime: {health.live.uptime}s)
                </span>
              </div>

              {health.ready && health.ready.report.services && (
                <div className="space-y-2">
                  <div className="text-xs font-semibold uppercase tracking-wider text-slate-400">
                    Infrastructure Readiness
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    {Object.entries(health.ready.report.services).map(([name, svc]) => (
                      <div
                        key={name}
                        className="bg-slate-800/30 border border-slate-800 p-2.5 rounded-lg flex items-center justify-between"
                      >
                        <span className="capitalize text-slate-300">{name}</span>
                        <span
                          className={`px-1.5 py-0.5 rounded text-[11px] font-medium border ${
                            svc?.status === "up"
                              ? "bg-emerald-950 text-emerald-400 border-emerald-800"
                              : "bg-amber-950 text-amber-400 border-amber-800"
                          }`}
                        >
                          {svc?.status === "up" ? `● UP (${svc.latencyMs}ms)` : "○ DOWN"}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {health.lastChecked && (
            <div className="mt-4 pt-3 border-t border-slate-800/60 text-[11px] text-slate-500 text-right">
              Last checked: {health.lastChecked.toLocaleTimeString()}
            </div>
          )}
        </div>
      </main>

      {/* Footer */}
      <footer className="border-t border-slate-800/80 px-6 py-4 text-center text-xs text-slate-500">
        ConnectSphere System Design Practical · Built with React, Express, PostgreSQL, MongoDB, Redis, RabbitMQ &amp; MinIO
      </footer>
    </div>
  );
}

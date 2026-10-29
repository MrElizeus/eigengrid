import { describe, expect, test } from "bun:test";
import {
  SYNTHETIC_MDINFO_PARTIAL,
  SYNTHETIC_MDOUT_COMPLETE,
  SYNTHETIC_MDOUT_SHAKE_FATAL,
} from "../fixtures/synthetic";
import { parseAmberMdTelemetry } from "../src/index";
import { telemetryRequest } from "./helpers";

describe("normalized AMBER mdout/mdinfo parsing", () => {
  test.each(["0x10", "0b10", "0o10"])("rejects non-AMBER numeric token %s", (token) => {
    const text = `NSTEP = 100 TIME(PS) = 0.2 TEMP(K) = ${token}\n5. TIMINGS\n`;
    const result = parseAmberMdTelemetry(text, telemetryRequest(text));
    expect(result.status).toBe("fatal");
    expect(result.metricSeries).toEqual([]);
  });
  test("promotes only confirmed, normally terminated mdout to durable metric series", () => {
    const result = parseAmberMdTelemetry(
      SYNTHETIC_MDOUT_COMPLETE,
      telemetryRequest(SYNTHETIC_MDOUT_COMPLETE),
    );

    expect(result.status).toBe("completed");
    expect(result.terminalMarkerObserved).toBe(true);
    expect(result.samples).toHaveLength(2);
    expect(result.samples[0]).toMatchObject({
      step: 100,
      timePs: 0.2,
      values: {
        temperature: 300.1,
        pressure: 1.1,
        total_energy: -1000,
        potential_energy: -1200,
        kinetic_energy: 200,
        volume: 95000,
        density: 1.001,
      },
    });
    expect(result.metricSeries).toHaveLength(7);
    expect(result.metricSeries.find((series) => series.metric === "temperature")?.unit).toBe("K");
    expect(result.lastStep).toBe(200);
    expect(result.lastTimePs).toBe(0.4);
  });

  test("keeps mdinfo and unconfirmed mdout provisional even when telemetry is readable", () => {
    const mdinfo = parseAmberMdTelemetry(SYNTHETIC_MDINFO_PARTIAL, {
      ...telemetryRequest(SYNTHETIC_MDINFO_PARTIAL, { sourceKind: "mdinfo" }),
    });
    expect(mdinfo.status).toBe("partial");
    expect(mdinfo.samples).toHaveLength(1);
    expect(mdinfo.units).toMatchObject({ temperature: "K", pressure: "bar" });
    expect(mdinfo.metricSeries).toEqual([]);

    const unconfirmed = parseAmberMdTelemetry(
      SYNTHETIC_MDOUT_COMPLETE,
      telemetryRequest(SYNTHETIC_MDOUT_COMPLETE, {
        executionCompletion: "unconfirmed",
        exitCode: null,
      }),
    );
    expect(unconfirmed.status).toBe("partial");
    expect(unconfirmed.metricSeries).toEqual([]);

    const { operationReceiptRef: _operationReceiptRef, ...withoutReceipt } =
      telemetryRequest(SYNTHETIC_MDOUT_COMPLETE);
    expect(() => parseAmberMdTelemetry(SYNTHETIC_MDOUT_COMPLETE, withoutReceipt)).toThrow(
      /exact receipt/u,
    );

    const exactUnconfirmed = telemetryRequest(SYNTHETIC_MDOUT_COMPLETE, {
      executionCompletion: "unconfirmed",
      exitCode: null,
    });
    expect(() =>
      parseAmberMdTelemetry(SYNTHETIC_MDOUT_COMPLETE, {
        ...exactUnconfirmed,
        exitCode: 0,
      }),
    ).toThrow(/exact stage result/u);
    expect(() =>
      parseAmberMdTelemetry(SYNTHETIC_MDOUT_COMPLETE, {
        ...exactUnconfirmed,
        operationReceiptRef: "receipt-from-another-operation",
      }),
    ).toThrow(/exact stage result/u);
  });

  test("fatal signatures, overflow, nonzero exit, and digest mismatch cannot pass", () => {
    const shake = parseAmberMdTelemetry(
      SYNTHETIC_MDOUT_SHAKE_FATAL,
      telemetryRequest(SYNTHETIC_MDOUT_SHAKE_FATAL),
    );
    expect(shake.status).toBe("fatal");
    expect(shake.diagnostics.map((item) => item.code)).toContain("shake_failure");

    const overflowText = "NSTEP = 5 TIME(PS) = 0.010 Etot = ********\n5. TIMINGS\n";
    const overflow = parseAmberMdTelemetry(overflowText, telemetryRequest(overflowText));
    expect(overflow.status).toBe("fatal");
    expect(overflow.diagnostics.map((item) => item.code)).toContain("numeric_overflow");

    const nonzero = parseAmberMdTelemetry(
      SYNTHETIC_MDOUT_COMPLETE,
      telemetryRequest(SYNTHETIC_MDOUT_COMPLETE, { exitCode: 7 }),
    );
    expect(nonzero.status).toBe("nonzero_exit");
    expect(nonzero.metricSeries).toEqual([]);

    const signalled = parseAmberMdTelemetry(
      SYNTHETIC_MDOUT_COMPLETE,
      telemetryRequest(SYNTHETIC_MDOUT_COMPLETE, { exitCode: null, signal: "SIGTERM" }),
    );
    expect(signalled.status).toBe("fatal");
    expect(signalled.metricSeries).toEqual([]);

    const request = telemetryRequest(SYNTHETIC_MDOUT_COMPLETE);
    expect(() =>
      parseAmberMdTelemetry(SYNTHETIC_MDOUT_COMPLETE, {
        ...request,
        source: { ...request.source, contentDigest: "f".repeat(64) },
      }),
    ).toThrow(/exact artifact/u);
  });

  test("refuses to normalize a non-monotonic telemetry stream", () => {
    const text = [
      "NSTEP = 100 TIME(PS) = 0.2 TEMP(K) = 300",
      "NSTEP = 90 TIME(PS) = 0.1 TEMP(K) = 301",
      "5. TIMINGS",
      "",
    ].join("\n");
    const result = parseAmberMdTelemetry(text, telemetryRequest(text));
    expect(result.status).toBe("fatal");
    expect(result.diagnostics.map((item) => item.code)).toContain("telemetry_discontinuity");
  });

  test("ignores Amber's repeated summary blocks", () => {
    const text = [
      " NSTEP = 1 TIME(PS) = 0.001 TEMP(K) = 300 PRESS = 0.0",
      " Etot = -10.0 EKtot = 2.0 EPtot = -12.0",
      " NSTEP = 2 TIME(PS) = 0.002 TEMP(K) = 301 PRESS = 0.0",
      " Etot = -10.1 EKtot = 2.1 EPtot = -12.2",
      "      A V E R A G E S   O V E R       2 S T E P S",
      " NSTEP = 2 TIME(PS) = 0.002 TEMP(K) = 301 PRESS = 0.0",
      " Etot = -10.1 EKtot = 2.1 EPtot = -12.2",
      "      R M S  F L U C T U A T I O N S",
      " NSTEP = 2 TIME(PS) = 0.002 TEMP(K) = 301 PRESS = 0.0",
      " Etot = -10.1 EKtot = 2.1 EPtot = -12.2",
      " 5.  TIMINGS",
      "",
    ].join("\n");

    const result = parseAmberMdTelemetry(text, telemetryRequest(text));

    expect(result.status).toBe("completed");
    expect(result.samples).toHaveLength(2);
    expect(result.lastStep).toBe(2);
    expect(result.diagnostics.map((item) => item.code)).not.toContain("telemetry_discontinuity");
    expect(result.metricSeries).toHaveLength(5);
  });

  test("scans diagnostics after FINAL RESULTS without extracting trailing telemetry", () => {
    const warningText = `${SYNTHETIC_MDOUT_COMPLETE}\nWARNING trailing diagnostic\n`;
    const warning = parseAmberMdTelemetry(warningText, telemetryRequest(warningText));
    expect(warning.status).toBe("completed");
    expect(warning.samples).toHaveLength(2);
    expect(warning.diagnostics.map((item) => item.code)).toContain("engine_warning");

    const fatalText = `${SYNTHETIC_MDOUT_COMPLETE}\nFATAL trailing diagnostic\n`;
    const fatal = parseAmberMdTelemetry(fatalText, telemetryRequest(fatalText));
    expect(fatal.status).toBe("fatal");
    expect(fatal.metricSeries).toEqual([]);
    expect(fatal.diagnostics.map((item) => item.code)).toContain("engine_fatal");
  });
});

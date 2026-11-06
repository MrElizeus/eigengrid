import { expect, test } from "bun:test";
import type { ToolContext } from "@eigengrid/tool-registry";
import { inspectProtocolTool, listProtocolsTool } from "./scientific-catalog-tools";

const context = {} as ToolContext;

test("routes Spanish magnetic questions to the appropriate versioned procedure", async () => {
  const cases = [
    [
      "¿Cómo paso de blindajes de protones y carbonos a desplazamientos de RMN?",
      "workflows.nmr-chemical-shifts",
    ],
    [
      "Quiero un barrido de sondas sobre un anillo inclinado para estudiar la aromaticidad",
      "workflows.nics-tensor-scans",
    ],
    [
      "¿Cómo integro las corrientes anulares si el flujo en el enlace central es cero?",
      "workflows.gimic-ring-currents",
    ],
  ] as const;
  for (const [query, id] of cases) {
    const result = await listProtocolsTool.execute(context, { query, limit: 1 });
    expect(result.data?.protocols[0]?.id).toBe(id);
    const inspected = await inspectProtocolTool.execute(context, {
      id,
      version: "1.0.0",
      corpusDigest: result.data!.corpusDigest,
    });
    expect(inspected.data?.protocol.capabilityLevels.executable).toEqual({});
    expect(inspected.data?.protocol.capabilityLevels.validated).toEqual({});
    expect(
      inspected.data?.fragments.some((f) => f.complete && f.relativePath.startsWith("protocols/")),
    ).toBe(true);
  }
});

test("preserves the isotope-specific ppm and exchange examples returned to the operator", async () => {
  const result = await inspectProtocolTool.execute(context, {
    id: "workflows.nmr-chemical-shifts",
    version: "1.0.0",
    assetKinds: ["protocols"],
  });
  const fragment = result.data!.fragments.find((f) => f.relativePath === "protocols/core.yaml")!;
  const { arithmetic_control: control } = Bun.YAML.parse(fragment.content) as {
    arithmetic_control: {
      populations: { A: number; B: number };
      cases: Array<{
        isotope: string;
        sigma_ref_ppm: number;
        sigma_A_ppm: number;
        sigma_B_ppm: number;
        slow_exchange_delta_ppm: number[];
        fast_exchange_delta_ppm: number;
      }>;
    };
  };
  expect(control.populations.A + control.populations.B).toBeCloseTo(1);
  expect(control.cases.map((row) => row.isotope).sort()).toEqual(["13C", "1H"]);
  for (const row of control.cases) {
    const deltaA = row.sigma_ref_ppm - row.sigma_A_ppm;
    const deltaB = row.sigma_ref_ppm - row.sigma_B_ppm;
    expect(row.slow_exchange_delta_ppm).toEqual([deltaA, deltaB]);
    expect(row.fast_exchange_delta_ppm).toBeCloseTo(
      control.populations.A * deltaA + control.populations.B * deltaB,
      8,
    );
  }
});

test("NICS normal projection survives a rotation where the printed laboratory zz changes", async () => {
  const result = await inspectProtocolTool.execute(context, {
    id: "workflows.nics-tensor-scans",
    version: "1.0.0",
    assetKinds: ["validation"],
  });
  const fragment = result.data!.fragments.find(
    (f) => f.relativePath === "validation/controls.yaml",
  )!;
  const { synthetic_control: c } = Bun.YAML.parse(fragment.content) as {
    synthetic_control: {
      sigma_ring_ppm: number[][];
      normal_ring: number[];
      sigma_out_ppm: number[][];
      normal_output: number[];
      expected_nics_iso_ppm: number;
      expected_nics_perp_ppm: number;
    };
  };
  for (const [sigma, n] of [
    [c.sigma_ring_ppm, c.normal_ring],
    [c.sigma_out_ppm, c.normal_output],
  ] as const) {
    const trace = sigma.reduce((sum, row, i) => sum + row[i], 0);
    const normalProjection = sigma.reduce(
      (sum, row, i) => sum + n[i] * row.reduce((dot, value, j) => dot + value * n[j], 0),
      0,
    );
    expect(-trace / 3).toBeCloseTo(c.expected_nics_iso_ppm, 8);
    expect(-normalProjection).toBeCloseTo(c.expected_nics_perp_ppm, 8);
  }
  expect(-c.sigma_out_ppm[2][2]).not.toBeCloseTo(c.expected_nics_perp_ppm);
});

test("an ORCA shielding calculation cannot qualify the downstream GIMIC bridge", async () => {
  const listed = await listProtocolsTool.execute(context, { engine: "orca", limit: 100 });
  expect(listed.data?.protocols.map((item) => item.id)).not.toContain(
    "workflows.gimic-ring-currents",
  );
  const inspected = await inspectProtocolTool.execute(context, {
    id: "workflows.gimic-ring-currents",
    version: "1.0.0",
    assetKinds: ["protocols"],
  });
  const fragment = inspected.data!.fragments.find((f) => f.relativePath === "protocols/core.yaml")!;
  const protocol = Bun.YAML.parse(fragment.content) as {
    effect_authority: string;
    missing_input_behavior: string;
    steps: { id: string; reason: string }[];
  };
  expect(protocol.effect_authority).toBe("none");
  expect(protocol.missing_input_behavior).toBe("block");
  expect(protocol.steps.find((s) => s.id === "verify-interface")?.reason).toContain("XDENS");
  expect(protocol.steps.find((s) => s.id === "verify-signed-flux")?.reason).toContain("finite");
});

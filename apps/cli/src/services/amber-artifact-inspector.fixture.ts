/** Independently authored CDF-1 format fixture: five frames, three atoms,
 * 1 fs cadence, finite coordinates and a varying orthogonal NPT cell.
 * Synthetic format bytes, never an Amber execution or scientific evidence. */
export function periodicAmberTrajectoryFixture(): Buffer {
  const uint = (value: number) => {
    const result = Buffer.alloc(4);
    result.writeUInt32BE(value);
    return result;
  };
  const name = (value: string) =>
    Buffer.concat([
      uint(value.length),
      Buffer.from(value, "ascii"),
      Buffer.alloc((-value.length >>> 0) % 4),
    ]);
  const attributes = (values: Record<string, string>) =>
    Buffer.concat([
      uint(12),
      uint(Object.keys(values).length),
      ...Object.entries(values).map(([key, value]) =>
        Buffer.concat([name(key), uint(2), name(value)]),
      ),
    ]);
  const dimensions = [
    ["frame", 0],
    ["atom", 3],
    ["spatial", 3],
    ["cell_spatial", 3],
    ["cell_angular", 3],
  ] as const;
  const variables = [
    { name: "time", dims: [0], units: "picosecond", values: (frame: number) => [frame * 0.001] },
    {
      name: "coordinates",
      dims: [0, 1, 2],
      units: "angstrom",
      values: (frame: number) => Array.from({ length: 9 }, (_, index) => frame + index),
    },
    {
      name: "cell_lengths",
      dims: [0, 3],
      units: "angstrom",
      values: (frame: number) => [20 + frame, 30 + frame, 40 + frame],
    },
    { name: "cell_angles", dims: [0, 4], units: "degree", values: () => [90, 90, 90] },
  ];
  const prefix = Buffer.concat([
    Buffer.from("CDF\x01", "binary"),
    uint(5),
    uint(10),
    uint(dimensions.length),
    ...dimensions.map(([label, size]) => Buffer.concat([name(label), uint(size)])),
    attributes({ Conventions: "AMBER" }),
    uint(11),
    uint(variables.length),
  ]);
  const declarations = variables.map((variable) =>
    Buffer.concat([
      name(variable.name),
      uint(variable.dims.length),
      ...variable.dims.map(uint),
      attributes({ units: variable.units }),
      uint(5),
      uint(variable.values(1).length * 4),
      uint(0),
    ]),
  );
  let begin =
    prefix.length + declarations.reduce((sum, declaration) => sum + declaration.length, 0);
  for (const [index, declaration] of declarations.entries()) {
    declaration.writeUInt32BE(begin, declaration.length - 4);
    begin += variables[index]!.values(1).length * 4;
  }
  const frames = Array.from({ length: 5 }, (_, index) =>
    Buffer.concat(
      variables.map((variable) => {
        const values = variable.values(index + 1);
        const bytes = Buffer.alloc(values.length * 4);
        values.forEach((value, offset) => bytes.writeFloatBE(value, offset * 4));
        return bytes;
      }),
    ),
  );
  return Buffer.concat([prefix, ...declarations, ...frames]);
}

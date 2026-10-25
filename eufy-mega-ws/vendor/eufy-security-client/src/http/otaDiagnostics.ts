const recordOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" ? (value as Record<string, unknown>) : {};

const safeString = (value: unknown): string => (typeof value === "string" ? value : "");

const safeFieldNames = (record: Record<string, unknown>): string[] =>
  Object.keys(record)
    .filter((name) => /^[A-Za-z0-9_.-]{1,64}$/.test(name))
    .sort();

const safeText = (value: unknown, maxLength: number): string | null => {
  if (typeof value !== "string" || value.length === 0 || value.length > maxLength) return null;
  return /^[A-Za-z0-9_.-]+$/.test(value) ? value : null;
};

const safeHostname = (value: unknown): string | null => {
  if (typeof value !== "string" || value.length === 0 || value.length > 4096) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname.length <= 255 ? url.hostname.toLowerCase() : null;
  } catch {
    return null;
  }
};

export const summarizeE10OtaRecords = (
  targetedRecords: Record<string, unknown>[],
  batchRecords: Record<string, unknown>[] = []
): Record<string, unknown> => {
  const record =
    targetedRecords[0] ?? batchRecords.find((item) => safeString(item.device_type).toUpperCase().startsWith("T87A0"));
  if (!record) return { recordFound: false, returnedFieldNames: [], packageObjects: [] };

  const packageObjects = Object.entries(record)
    .filter(([name, value]) => /package/i.test(name) && value && typeof value === "object" && !Array.isArray(value))
    .map(([name, value]) => {
      const packageRecord = recordOf(value);
      const filePath = packageRecord.file_path;
      const fileSize =
        typeof packageRecord.file_size === "number" &&
        Number.isFinite(packageRecord.file_size) &&
        packageRecord.file_size >= 0
          ? packageRecord.file_size
          : null;
      const fileMd5 =
        typeof packageRecord.file_md5 === "string" && /^[a-f0-9]{32}$/i.test(packageRecord.file_md5)
          ? packageRecord.file_md5.toLowerCase()
          : null;
      return {
        name,
        returnedFieldNames: safeFieldNames(packageRecord),
        filename: safeText(packageRecord.file_name, 255),
        size: fileSize,
        md5: fileMd5,
        filePathPresent: typeof filePath === "string" && filePath.length > 0,
        urlHostname: safeHostname(filePath),
      };
    })
    .sort((left, right) => left.name.localeCompare(right.name));

  return {
    recordFound: true,
    returnedFieldNames: safeFieldNames(record),
    packageObjects,
    rom_version_name: safeText(record.rom_version_name, 128),
  };
};

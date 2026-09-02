"use strict";

const HOMEBASE_MODELS = {
  T8030: { name: "S380 HomeBase 3", generation: "legacy" },
  T9000: { name: "HomeBase Professional", generation: "target" },
};

function summarizeHomeBaseTransition(deviceRows = [], stationRows = []) {
  const bases = stationRows
    .filter((station) => HOMEBASE_MODELS[station.model])
    .map((station) => {
      const assigned = deviceRows.filter(
        (device) => device.stationSerialNumber === station.serialNumber,
      );
      const cameras = assigned.filter((device) => device.model !== "T87A0");
      return {
        model: station.model,
        name: HOMEBASE_MODELS[station.model].name,
        generation: HOMEBASE_MODELS[station.model].generation,
        endpoints: 1,
        assignedDevices: assigned.length,
        assignedCameras: cameras.length,
        camerasWithSnapshots: cameras.filter((device) => device.snapshot).length,
        streamCapableCameras: cameras.filter((device) => device.streaming).length,
        localRecordIndex: station.localRecordIndex,
        dateRecordIndex: station.dateRecordIndex,
        thumbnailDownload: station.thumbnailDownload,
      };
    });

  const legacy = bases.find((base) => base.generation === "legacy");
  const target = bases.find((base) => base.generation === "target");
  const unassignedDevices = deviceRows.filter(
    (device) => device.stationSerialNumber
      && !stationRows.some((station) => station.serialNumber === device.stationSerialNumber),
  ).length;

  return {
    phase: legacy && target
      ? "parallel_migration"
      : target
        ? "professional_only"
        : legacy
          ? "s380_only"
          : "not_detected",
    overlapHealthy: Boolean(legacy && target),
    stableCameraIdentity: true,
    safeToRetireS380: Boolean(target && (!legacy || legacy.assignedDevices === 0)),
    unassignedDevices,
    bases,
    note: "Camera entities retain their camera serial identity when station ownership changes. Keep the S380 online until its assigned-device count reaches zero and migrated cameras have snapshots and streams on the Professional base.",
  };
}

module.exports = { summarizeHomeBaseTransition };

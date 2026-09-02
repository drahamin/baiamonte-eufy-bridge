"use strict";

const assert = require("assert");
const { summarizeHomeBaseTransition } = require("../eufy-mega-ws/dashboard/homebase-transition.cjs");

const stations = [
  { serialNumber: "old-private", model: "T8030", localRecordIndex: true, dateRecordIndex: true, thumbnailDownload: true },
  { serialNumber: "new-private", model: "T9000", localRecordIndex: false, dateRecordIndex: false, thumbnailDownload: true },
];
const cameras = [
  { serialNumber: "camera-a", stationSerialNumber: "old-private", model: "T8423", snapshot: true, streaming: true },
  { serialNumber: "camera-b", stationSerialNumber: "new-private", model: "T8173", snapshot: true, streaming: true },
];

const during = summarizeHomeBaseTransition(cameras, stations);
assert.equal(during.phase, "parallel_migration");
assert.equal(during.safeToRetireS380, false);
assert.equal(during.unassignedDevices, 0);
assert.deepEqual(during.bases.map((base) => base.assignedCameras), [1, 1]);
assert(!JSON.stringify(during).includes("old-private"));
assert(!JSON.stringify(during).includes("new-private"));

const after = summarizeHomeBaseTransition(
  cameras.map((camera) => ({ ...camera, stationSerialNumber: "new-private" })),
  stations,
);
assert.equal(after.safeToRetireS380, true);
assert.deepEqual(after.bases.map((base) => base.assignedCameras), [0, 2]);

const orphaned = summarizeHomeBaseTransition(
  [{ ...cameras[0], stationSerialNumber: "missing-private" }],
  stations,
);
assert.equal(orphaned.unassignedDevices, 1);

console.log("homebase transition checks passed");

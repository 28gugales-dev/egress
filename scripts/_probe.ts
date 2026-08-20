import { DEFAULT_PARAMS, getScenario, LANE_CAPACITY, PARAM_AXES } from "../src/lib/constants";

console.log(
  "ok",
  LANE_CAPACITY.motorway,
  getScenario("camp-fire-2018").frameStep,
  DEFAULT_PARAMS.compliance,
);
console.log(
  "key",
  `${PARAM_AXES.compliance[6]}|${PARAM_AXES.shadowEvac[0]}|${PARAM_AXES.noticeTime[2]}|${PARAM_AXES.vehiclesPerHousehold[0]}`,
);

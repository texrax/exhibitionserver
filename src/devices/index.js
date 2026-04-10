// 裝置類型註冊表
// 新增裝置時只需在此檔 require 並加入 map 即可

const ESP32Device = require("./ESP32Device");
const AudioPlayerDevice = require("./AudioPlayerDevice");
const CameraSensorDevice = require("./CameraSensorDevice");
const VTubeStudioDevice = require("./VTubeStudioDevice");
const RemoteDevice = require("./RemoteDevice");
const YoloDetectorDevice = require("./YoloDetectorDevice");
const WizLightDevice = require("./WizLightDevice");
const OBSDevice = require("./OBSDevice");

/**
 * 裝置類型名稱 → 類別對應表
 * config/devices.json 中的 "type" 欄位必須對應此處的 key
 */
module.exports = {
  ESP32Device,
  AudioPlayerDevice,
  CameraSensorDevice,
  VTubeStudioDevice,
  RemoteDevice,
  YoloDetectorDevice,
  WizLightDevice,
  OBSDevice,
};

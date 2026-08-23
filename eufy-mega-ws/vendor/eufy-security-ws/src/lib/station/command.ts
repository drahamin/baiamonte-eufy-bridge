export enum StationCommand {
  reboot = "station.reboot",
  isConnected = "station.is_connected",
  connect = "station.connect",
  disconnect = "station.disconnect",
  getPropertiesMetadata = "station.get_properties_metadata",
  getProperties = "station.get_properties",
  getCameraInfo = "station.get_camera_info",
  getStorageInfo = "station.get_storage_info",
  setProperty = "station.set_property",
  hasProperty = "station.has_property",
  triggerAlarm = "station.trigger_alarm",
  resetAlarm = "station.reset_alarm",
  getCommands = "station.get_commands",
  hasCommand = "station.has_command",
  chime = "station.chime",
  downloadImage = "station.download_image",
  databaseQueryLatestInfo = "station.database_query_latest_info",
  databaseQueryLocal = "station.database_query_local",
  databaseQueryByDate = "station.database_query_by_date",
  databaseCountByDate = "station.database_count_by_date",
  databaseDelete = "station.database_delete",

  //Deprecated
  setGuardMode = "station.set_guard_mode",

  //Legacy
  isConnectedLegacy = "station.isConnected",
}

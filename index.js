const LTAPredCrowdLevel = require("./Scripts/Bus/Crowd Predictor/BusPredictedCrowdLevelGetter")
const MRTDataParser = require('./Scripts/MRT/MRTDataParser')

LTAPredCrowdLevel.createBusPredictedCrowdLevelData()
MRTDataParser.parseMRTData();
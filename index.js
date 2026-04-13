require("dotenv").config();
const express = require("express");
const Console = require("./ConsoleUtils");
const CryptoUtils = require("./CryptoUtils");
const SharedUtils = require("./SharedUtils");

const {
  BackendUtils,
  UserModel,
  UserController,
  RoundController,
  BattlePassController,
  EconomyController,
  AnalyticsController,
  FriendsController,
  NewsController,
  MissionsController,
  TournamentXController,
  MatchmakingController,
  TournamentController,
  SocialController,
  EventsController,
  authenticate,
  OnlineCheck,
  VerifyPhoton
} = require("./BackendUtils");

const app = express();
const Title = "Stumble Echo Backend " + process.env.version;
const PORT = process.env.PORT || 80;

app.use(express.json());
app.use(authenticate);

// ================= ROTAS PRINCIPAIS =================

app.post("/photon/auth", VerifyPhoton);

// 🔥 LOGIN FIX
app.post("/login", (req, res) => {
  return VerifyPhoton(req, res);
});

app.get("/onlinecheck", (req, res) => {
  res.json({ status: "ok" });
});

app.get("/matchmaking/filter", MatchmakingController.getMatchmakingFilter);

// ================= USER =================

app.post('/user/login', UserController.login);
app.get('/user/config', (req, res) => { res.json({}); });
app.get('/usersettings', UserController.getSettings);
app.post('/user/updateusername', UserController.updateUsername);
app.get('/user/deleteaccount', UserController.deleteAccount);
app.post('/user/linkplatform', UserController.linkPlatform);
app.post('/user/unlinkplatform', UserController.unlinkPlatform);
app.post('/user/profile', UserController.getProfile);
app.post('/user-equipped-cosmetics/update', UserController.updateCosmetics);
app.post('/user/cosmetics/addskin', UserController.addSkin);
app.post('/user/cosmetics/setequipped', UserController.setEquippedCosmetic);

// ================= FRIENDS =================

app.post('/friends/request/accept', FriendsController.add);
app.delete('/friends/:UserId', FriendsController.remove);
app.get('/friends', FriendsController.list);
app.post('/friends/search', FriendsController.search);
app.post('/friends/request', FriendsController.request);
app.post('/friends/accept', FriendsController.accept);
app.post('/friends/request/decline', FriendsController.reject);
app.post('/friends/cancel', FriendsController.cancel);
app.get('/friends/request', FriendsController.pending);

// ================= SOCIAL =================

app.get('/social/interactions', SocialController.getInteractions);

// ================= ROUND =================

app.get('/round/finish/:round', RoundController.finishRound);
app.get('/round/finishv2/:round', RoundController.finishRound);
app.post('/round/finish/v4/:round', RoundController.finishRoundV4);
app.post('/round/eventfinish/v4/:round', RoundController.finishRoundV4);

app.post('/round/finish/v3/:country/:gameId/:userId', (req, res) => {
  req.params.round = req.body.Round;
  RoundController.finishRoundV4(req, res);
});

// ================= BATTLEPASS =================

app.get('/battlepass', BattlePassController.getBattlePass);
app.post('/battlepass/claimv3', BattlePassController.claimReward);
app.post('/battlepass/purchase', BattlePassController.purchaseBattlePass);
app.post('/battlepass/complete', BattlePassController.completeBattlePass);

// ================= ECONOMY =================

app.get('/economy/purchase/:item', EconomyController.purchase); 
app.get('/economy/purchasegasha/:itemId/:count', EconomyController.purchaseGasha); 
app.get('/economy/purchaseluckyspin', EconomyController.purchaseLuckySpin); 
app.get('/economy/purchasedrop/:itemId/:count', EconomyController.purchaseLuckySpin); 
app.post('/economy/:currencyType/give/:amount', EconomyController.giveCurrency); 

app.get('/economy/luckyspin', (req, res) =>
  EconomyController.getLuckySpin(req, res)
);

// ================= MISSIONS =================

app.get('/missions', MissionsController.getMissions);
app.post('/missions/:missionId/rewards/claim/v2', MissionsController.claimMissionReward);
app.post('/missions/objective/:objectiveId/:milestoneId/rewards/claim/v2', MissionsController.claimMilestoneReward);

// ================= EVENTS =================

app.get("/game-events/me", EventsController.getActive);

// ================= NEWS =================

app.get("/news/getall", NewsController.GetNews);

// ================= ANALYTICS =================

app.post('/analytics', AnalyticsController.analytic);

// ================= HIGHSCORE =================

app.get('/highscore/:type/list/', async (req, res, next) => {
  try {
    const { type } = req.params;
    const { start = 0, count = 100, country = 'global' } = req.query;

    const startNum = parseInt(start, 10);
    const countNum = parseInt(count, 10);

    if (!type) {
      return res.status(400).json({ error: "Tipo necessário" });
    }

    if (isNaN(startNum) || isNaN(countNum)) {
      return res.status(400).json({ error: "start/count inválidos" });
    }

    const result = await UserModel.GetHighscore(type, country, startNum, countNum);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// ================= TOURNAMENT =================

app.get("/tournamentx/active", TournamentXController.getActive);
app.get("/tournamentx/active/v2", TournamentXController.getActive);
app.post("/tournamentx/:tournamentId/join", TournamentXController.join);
app.post("/tournamentx/:tournamentId/leave", TournamentXController.leave);

app.post("/round/tournament/finish/v2", TournamentXController.finish);

app.get("/api/v1/ping", (req, res) => {
  res.status(200).send("OK");
});

app.post("/api/v1/userLoginExternal", TournamentController.login);
app.get("/api/v1/tournaments", TournamentController.getActive);

// ================= START =================

app.listen(PORT, () => {
  const currentDate = new Date().toLocaleString().replace(",", " |");
  console.clear();
  Console.log(
    "Server",
    `[${Title}] | ${currentDate} | ${CryptoUtils.SessionToken()}`
  );
  Console.log("Server", `Listening on port ${PORT}`);
});
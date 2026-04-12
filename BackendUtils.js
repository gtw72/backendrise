const express = require('express');
const { MongoClient, ObjectId } = require('mongodb');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const Console = require("./ConsoleUtils");
const dotenv = require('dotenv');
dotenv.config();
const CryptoUtils = require("./CryptoUtils");
const SharedUtils = require("./SharedUtils.js");
const SharedData = require("./shared.json");

const BackendUtils = {
  generateId: () => crypto.randomBytes(16).toString('hex'),
  createHash: (...args) => crypto.createHash('sha256').update(args.join('')).digest('hex'),
  getTimestamp: () => Math.floor(Date.now() / 1000),
  validateAuthHeader: (authHeader) => {
    if (!authHeader || typeof authHeader !== 'string') return null;
    try {
      const parsed = JSON.parse(authHeader);
      if (!parsed.DeviceId) return null;
      return { DeviceId: parsed.DeviceId, StumbleId: parsed.StumbleId };
    } catch {
      return null;
    }
  },
  createLoginHash: (deviceId, version, timestamp, stumbleId, steamTicket, scopelyId) => {
    const hashInput = `${deviceId}${version}${timestamp}${stumbleId || ''}${steamTicket || ''}${scopelyId || ''}${process.env.LeagueSalt}`;
    return crypto.createHash('md5').update(hashInput).digest('hex');
  },
  createRegularHash: (deviceId, googleId, token, timestamp, stumbleId, url, body) => {
    const hashInput = `${deviceId}${googleId}${token}${timestamp}${stumbleId}${url}${body || ''}${process.env.LeagueSalt}`;
    return crypto.createHash('md5').update(hashInput).digest('hex');
  },
  createGameId: (type = 'regular') => {
    const prefix = type === 'event' ? 'EV' : 'RG';
    return `${prefix}-${crypto.randomBytes(8).toString('hex').toUpperCase()}`;
  },
  formatNumber: (num) => {
    return new Intl.NumberFormat('en-US').format(num);
  },
  GenAndroidId: () => {
    return `android-${crypto.randomBytes(8).toString('hex')}`;
  },
  GenCaracters: (length) => {
    return crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length);
  },
  LeagueEncrypt: (text) => {
    const cipher = crypto.createCipheriv('aes-256-cbc', process.env.LeagueSalt, crypto.randomBytes(16));
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    return encrypted;
  },
  Hash: (algorithm, data) => {
    return crypto.createHash(algorithm).update(data).digest('hex');
  }
};

class Database {
  constructor() {
    this.mongoUri = process.env.mongoUri;
    this.dbName = 'StumblePrism';
    this.client = null;
    this.db = null;
    this.collections = {
      Users: null,
      Analytics: null,
      News: null,
      Events: null,
      BattlePasses: null,
      Skins: null,
      Missions: null,
      PurchasableItems: null,
      Animations: null,
      Emotes: null,
      Footsteps: null
    };
  }

  async connect() {
    this.client = new MongoClient(this.mongoUri);
    await this.client.connect();
    this.db = this.client.db(this.dbName);
    this.collections.Users = this.db.collection("Users");
    this.collections.Analytics = this.db.collection("Analytics");
    this.collections.News = this.db.collection("News");
    this.collections.Events = this.db.collection("Events");
    this.collections.BattlePasses = this.db.collection("BattlePasses");
    this.collections.Skins = this.db.collection("Skins");
    this.collections.Missions = this.db.collection("Missions");
    this.collections.PurchasableItems = this.db.collection("PurchasableItems");
    this.collections.Animations = this.db.collection("Animations");
    this.collections.Emotes = this.db.collection("Emotes");
    this.collections.Footsteps = this.db.collection("Footsteps");
    await this.createIndexes();
    await this.autoPopulateSharedData();
    Console.log("Database", 'Connected to database');
  }

  async autoPopulateSharedData() {
    try {
      if (SharedData.Skins_v4?.length > 0) {
        await this.collections.Skins.deleteMany({});
        for (const skin of SharedData.Skins_v4) {
          await this.collections.Skins.insertOne({ ...skin });
        }
      }
      if (SharedData.Animations_v2?.length > 0) {
        await this.collections.Animations.deleteMany({});
        for (const anim of SharedData.Animations_v2) {
          await this.collections.Animations.insertOne({ ...anim });
        }
      }
      if (SharedData.Emotes_v2?.length > 0) {
        await this.collections.Emotes.deleteMany({});
        for (const emote of SharedData.Emotes_v2) {
          await this.collections.Emotes.insertOne({ ...emote });
        }
      }
      if (SharedData.Footsteps?.length > 0) {
        await this.collections.Footsteps.deleteMany({});
        for (const footstep of SharedData.Footsteps_v2) {
          await this.collections.Footsteps.insertOne({ ...footstep });
        }
      }
    } catch (error) {
      Console.error('Populate', 'Erro ao popular coleções:', error);
    }
  }

  async createIndexes() {
    await this.collections.Users.createIndexes([
      { key: { deviceId: 1 }, unique: true, sparse: true },
      { key: { stumbleId: 1 }, unique: true, sparse: true },
      { key: { username: 1 }, unique: true, sparse: true },
      { key: { friends: 1 } },
      { key: { sentFriendRequests: 1 } },
      { key: { receivedFriendRequests: 1 } },
      { key: { 'balances.name': 1 } }
    ]);
    await this.collections.Events.createIndex({ StartDateTime: 1, EndDateTime: 1 });
    await this.collections.BattlePasses.createIndex({ PassID: 1 });
    await this.collections.Skins.createIndex({ SkinID: 1 });
  }

  async getUserByQuery(query) {
    return await this.collections.Users.findOne(query);
  }

  async updateUser(query, updates) {
    await this.collections.Users.updateOne(query, { $set: updates });
    return await this.getUserByQuery(query);
  }

  async addToUserArray(query, arrayField, value) {
    return await this.collections.Users.updateOne(query, { $addToSet: { [arrayField]: value } });
  }

  async incrementUserBalance(query, currency, amount) {
    const result = await this.collections.Users.updateOne(
      { ...query, 'balances.name': currency },
      { $inc: { 'balances.$.amount': amount } }
    );
    if (result.matchedCount === 0 && amount > 0) {
      await this.collections.Users.updateOne(
        query,
        { $push: { balances: { name: currency, amount } } }
      );
    }
    return result;
  }

  async createUser(userData) {
    const result = await this.collections.Users.insertOne(userData);
    return { ...userData, _id: result.insertedId };
  }

  async getActiveEvents() {
    const now = new Date();
    return await this.collections.Events.find({
      StartDateTime: { $lte: now },
      EndDateTime: { $gte: now }
    }).toArray();
  }

  async getBattlePass(passId) {
    return await this.collections.BattlePasses.findOne({ PassID: passId });
  }

  async getSkinInfo(skinId) {
    return await this.collections.Skins.findOne({ SkinID: skinId });
  }

  async getMissionInfo(missionId) {
    return await this.collections.Missions.findOne({ Id: missionId });
  }

  async getPurchasableItem(itemId) {
    return await this.collections.PurchasableItems.findOne({ Name: itemId });
  }
}

const database = new Database();
database.connect().catch(err => {
  console.error('Database connection error:', err);
  process.exit(1);
});

class UserModel {
  static async create(deviceId, platformData = {}) {
    const now = new Date();
    const userId = Math.floor(Math.random() * 999);
    const username = 'SGecho' + BackendUtils.GenCaracters(5).toUpperCase();
    const user = {
      id: userId,
      deviceId,
      stumbleId: BackendUtils.generateId().toUpperCase(),
      username,
      country: 'BR',
      region: 'SA',
      token: CryptoUtils.SessionToken(),
      version: platformData.Version || '0.99',
      createdAt: now,
      lastLogin: now,
      newsVersion: 0,
      skillRating: 0,
      experience: 0,
      crowns: 0,
      hiddenRating: 0,
      isBanned: false,
      friends: [],
      sentFriendRequests: [],
      receivedFriendRequests: [],
      inventory: [{
        userId,
        itemId: 803,
        itemType: "DUPLICATE_BANK",
        item: "CONFIG_VERSION",
        amount: 3
      }],
      skins: ["SKIN1", "SKIN2"],
      emotes: ["emote_cry", "emote_hi", "emote_gg", "emote_haha", "emote_happy"],
      animations: ["animation1"],
      footsteps: ["footsteps_smoke"],
      hasBattlePass: false,
      passTokens: 0,
      freePassRewards: [],
      premiumPassRewards: [],
      balances: [
        { name: "coins", amount: 101, secondsSince: 0, secondsPerUnit: 0, maxAmount: 0, lastGiven: now },
        { name: "remove_ads", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 2, lastGiven: now },
        { name: "video", amount: 50, secondsSince: 0, secondsPerUnit: 0, maxAmount: 5000, lastGiven: now },
        { name: "gems", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 0, lastGiven: now },
        { name: "video_gems", amount: 10, secondsSince: 0, secondsPerUnit: 5400, maxAmount: 10, lastGiven: now },
        { name: "video_coins", amount: 8, secondsSince: 0, secondsPerUnit: 10800, maxAmount: 8, lastGiven: now },
        { name: "special_video", amount: 3, secondsSince: 0, secondsPerUnit: 28800, maxAmount: 3, lastGiven: now },
        { name: "skin_charge", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 5, lastGiven: now },
        { name: "skin_purchase", amount: 7, secondsSince: 0, secondsPerUnit: 86400, maxAmount: 7, lastGiven: now },
        { name: "gem_charge", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 3, lastGiven: now },
        { name: "gem_purchase", amount: 1, secondsSince: 0, secondsPerUnit: 86400, maxAmount: 1, lastGiven: now },
        { name: "dust", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 0, lastGiven: now },
        { name: "default_free_spins", amount: 1, secondsSince: 0, secondsPerUnit: 0, maxAmount: 1, lastGiven: new Date(Date.now() - 86400000) },
        { name: "default_free_ad_spins", amount: 16, secondsSince: 0, secondsPerUnit: 0, maxAmount: 16, lastGiven: new Date(Date.now() - 86400000) },
        { name: "remove_interstitial_ads", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 2, lastGiven: now },
        { name: "end_of_match", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 1, lastGiven: now },
        { name: "end_of_match_event", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 1, lastGiven: now },
        { name: "tournament_ticket_rare", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 0, lastGiven: now },
        { name: "tournament_ticket_legendary", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 0, lastGiven: now },
        { name: "video_coins_02", amount: 5, secondsSince: 0, secondsPerUnit: 28800, maxAmount: 5, lastGiven: now },
        { name: "aes", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 0, lastGiven: now },
        { name: "aec", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 0, lastGiven: now },
        { name: "ranked_friend_boost", amount: 3, secondsSince: 0, secondsPerUnit: 86400, maxAmount: 3, lastGiven: now },
        { name: "stumble_coins", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 0, lastGiven: now },
        { name: "dust_backup", amount: 0, secondsSince: 0, secondsPerUnit: 0, maxAmount: 0, lastGiven: now }
      ],
      Rewards: [],
      availableNewsVersion: 0,
      latestNewsIdBackend: 11698,
      battlePass: {
        freePassRewards: [],
        premiumPassRewards: [],
        passTokens: 0,
        hasPurchased: false,
        passID: 72,
        secondsToEnd: 904064,
        experience: 0,
        slotsClaimed: [],
        hasUsedDiscount: false,
        xpBooster: 0,
        coins: 0,
        hasUsedBonusDiscount: false,
        passDateId: 0
      },
      secondsSinceCreated: 0,
      age: 0,
      kidFriendlyMode: 0,
      termsOfServiceVersion: 0,
      xpRoad: {
        userId,
        xpRoadId: 0,
        lastClaimedLevel: 1,
        isVeteran: true,
        claimedRewardsIds: [],
        hasBeenEnabled: true,
        currentLevelCap: 70,
        isOnboarding: false,
        onboardingFeaturesUnlocked: []
      },
      userFlags: {
        hasUsedFreeNameChange: false,
        hasCoinConversionPopupShown: false,
        hasCoinConversionCompleted: false
      },
      offerSequenceState: [],
      userProfile: {
        userId,
        userName: username,
        country: 'BR',
        trophies: 0,
        crowns: 0,
        experience: 0,
        hiddenRating: 0,
        isOnline: true,
        lastSeenDate: now.toISOString(),
        skin: "SKIN1",
        nativePlatformName: "android",
        ranked: {
          currentSeasonId: "LIVE_RANKED_SEASON_12",
          currentRankId: 0,
          currentTierIndex: 0
        },
        flags: 0
      },
      featureFlags: [
        "ActionEmotes", "ActionEmotesCustomPartyVisibility", "age-request",
        "AssignInitialPhotonRegionBasedOnPing", "AutomatedShardSources", "AvailableCosmetics",
        "BattlePassActivationButton", "BattlePassOffer", "BattlePassPremiumPopupImprovement",
        "BattlePassSkipButtonOnSections", "BattlePassTheme", "BattlePassV2", "Consensus",
        "ConsoleFreeSpin", "CreatorCodes", "CreatorsQR", "CustomizeEmotesOnCustomPartyLobby",
        "CustomParty", "DeltaSharedConfig", "DiscoverabilityEvents", "DynamicContainer",
        "EndOfMatchRewardedVideo", "Events", "FriendsList", "GameplayAds",
        "GamePlayInGameNotifications", "GlobalLTCMetaEvent", "GraphicsQualitySettings",
        "HelpshiftConversation", "InAppMessageGifting", "LateJoinResyncSystem", "Leaderboards",
        "LocalNotifications", "LootBoxes", "MainMenuRevamp", "MatchmakingFilter",
        "MemoryFixesSections", "MergeParties", "Missions", "NewMatchmaking", "Offerwall",
        "OldPurchaserImplementation", "OneStopShop", "OneStopShop3dAnimations",
        "OneStopShop3dSkins", "OneStopShop3dTaunts", "PluginFactory", "ProjectVerano", "Pusher",
        "QuantumSystemManagement", "Ranked", "RankedPlayWithFriends", "RemoteLocalizations",
        "RoomManagement", "RoomManagementConsole", "SavePhotonRegionOnBackend", "ScopelyAccount",
        "ScopelyAccountApple", "SequentialOffers", "Shards", "ShardsDuplicateBank",
        "ShopOfferCentering", "ShopOfferPurchaseLimitIndicator", "SimulationGamePayload",
        "SpecialEmoteFilter", "StartupNewFlow", "StaticBundles", "SteamInventory",
        "TransferAppleIdAuthorization", "UsePhotonTicketsEvents", "UsePhotonTicketsTournamentsX",
        "UserConfiguration", "UserGeneratedContent", "UserTimeRecords", "WebGLRealMoneyOffers",
        "WorkshopCustomThumbnails", "XpRoad"
      ],
      googleId: platformData.googleId || '',
      facebookId: platformData.facebookId || '',
      appleId: platformData.appleId || '',
      scopelyId: platformData.scopelyId || '',
      steamTicket: platformData.steamTicket || '',
      equippedCosmetics: {
        skin: 'SKIN1',
        color: 'COLOR1',
        animation: 'animation1',
        footsteps: 'footsteps_smoke',
        emote1: 'emote_cry',
        emote2: 'emote_hi',
        emote3: 'emote_gg',
        emote4: 'emote_haha',
        actionEmote1: 1,
        actionEmote2: 2,
        actionEmote3: 3,
        actionEmote4: 4
      }
    };
    return await database.createUser(user);
  }

  static async findByDeviceId(deviceId) {
    return await database.getUserByQuery({ deviceId });
  }

  static async findByStumbleId(stumbleId) {
    return await database.getUserByQuery({ stumbleId });
  }

  static async findById(id) {
    return await database.getUserByQuery({ id: parseInt(id) });
  }

  static async update(stumbleId, updates) {
    return await database.updateUser({ stumbleId }, updates);
  }

  static async addBalance(deviceId, currency, amount) {
    return await database.incrementUserBalance({ deviceId }, currency, amount);
  }

  static async removeBalance(deviceId, currency, amount) {
    return await database.incrementUserBalance({ deviceId }, currency, -amount);
  }

  static async addSkin(stumbleId, skinId) {
    return await database.addToUserArray({ stumbleId }, 'skins', skinId);
  }

  static async addActionEmote(stumbleId, emoteId) {
    return await database.addToUserArray({ stumbleId }, 'actionEmotes', emoteId);
  }

  static async setEquippedCosmetic(stumbleId, cosmeticType, cosmeticId) {
    const user = await this.findByStumbleId(stumbleId);
    if (!user) throw new Error("User not found");
    const updatedCosmetics = { ...user.equippedCosmetics, [cosmeticType]: cosmeticId };
    return await this.update(stumbleId, { equippedCosmetics: updatedCosmetics });
  }

  static async claimBattlePassSlot(deviceId, slotKey) {
    const user = await this.findByDeviceId(deviceId);
    if (user.battlePass.slotsClaimed.includes(slotKey)) {
      throw new Error("Slot already claimed");
    }
    await database.collections.Users.updateOne(
      { deviceId },
      { $push: { 'battlePass.slotsClaimed': slotKey } }
    );
    return await this.findByDeviceId(deviceId);
  }

  static async addBattlePassExperience(deviceId, xpToAdd) {
    const user = await this.findByDeviceId(deviceId);
    const newXP = (user.battlePass.experience || 0) + xpToAdd;
    await database.collections.Users.updateOne(
      { deviceId },
      { $set: { 'battlePass.experience': newXP } }
    );
    return await this.findByDeviceId(deviceId);
  }

  static async GetHighscore(type, country, start = 0, count = 50) {
    const filter = {};
    const projection = { username: 1, country: 1, _id: 0 };
    let sortField;
    let valueField;
    if (type === "crowns") {
      filter.crowns = { $gt: 0 };
      projection.crowns = 1;
      sortField = "crowns";
      valueField = "Crowns";
    } else if (type === "rank") {
      filter.skillRating = { $gt: 0 };
      projection.skillRating = 1;
      sortField = "skillRating";
      valueField = "SkillRating";
    }
    if (country && country.toLowerCase() !== "") {
      filter.country = country;
    }
    const users = await database.collections.Users
      .find(filter)
      .sort({ [sortField]: -1 })
      .project(projection)
      .skip(parseInt(start))
      .limit(parseInt(count))
      .toArray();
    if (users.length === 0) {
      return { Error: "No users found" };
    }
    const scores = users.map(user => {
      const value = type === "crowns" ? user.crowns : user.skillRating;
      return {
        User: {
          Username: user.username,
          Country: user.country || "Unknown",
          [valueField]: value
        }
      };
    });
    return { scores };
  }

  static async getBalanceAmount(user, currency) {
    const balance = user.balances.find(b => b.name === currency);
    return balance ? balance.amount : 0;
  }

  static async getLevel(xp) {
    return Math.floor((xp + 1032700) / 30000) - 9;
  }

  // ====================== SISTEMA DE AMIGOS ======================
  static async sendFriendRequest(senderStumbleId, receiverStumbleId) {
    if (senderStumbleId === receiverStumbleId) throw new Error("Não pode adicionar a si mesmo");
    const sender = await this.findByStumbleId(senderStumbleId);
    const receiver = await this.findByStumbleId(receiverStumbleId);
    if (!receiver) throw new Error("Usuário não encontrado");
    if (sender.friends?.includes(receiverStumbleId)) throw new Error("Já são amigos");
    if (sender.sentFriendRequests?.includes(receiverStumbleId)) throw new Error("Solicitação já enviada");
    await database.collections.Users.updateOne(
      { stumbleId: senderStumbleId },
      { $addToSet: { sentFriendRequests: receiverStumbleId } }
    );
    await database.collections.Users.updateOne(
      { stumbleId: receiverStumbleId },
      { $addToSet: { receivedFriendRequests: senderStumbleId } }
    );
    return { success: true, message: "Solicitação enviada" };
  }

  static async acceptFriendRequest(userStumbleId, requesterStumbleId) {
    await database.collections.Users.updateOne(
      { stumbleId: userStumbleId },
      {
        $pull: { receivedFriendRequests: requesterStumbleId },
        $addToSet: { friends: requesterStumbleId }
      }
    );
    await database.collections.Users.updateOne(
      { stumbleId: requesterStumbleId },
      {
        $pull: { sentFriendRequests: userStumbleId },
        $addToSet: { friends: userStumbleId }
      }
    );
    return { success: true, message: "Amizade aceita" };
  }

  static async rejectFriendRequest(userStumbleId, requesterStumbleId) {
    await database.collections.Users.updateOne(
      { stumbleId: userStumbleId },
      { $pull: { receivedFriendRequests: requesterStumbleId } }
    );
    await database.collections.Users.updateOne(
      { stumbleId: requesterStumbleId },
      { $pull: { sentFriendRequests: userStumbleId } }
    );
    return { success: true, message: "Solicitação recusada" };
  }

  static async removeFriend(userStumbleId, friendStumbleId) {
    await database.collections.Users.updateOne(
      { stumbleId: userStumbleId },
      { $pull: { friends: friendStumbleId } }
    );
    await database.collections.Users.updateOne(
      { stumbleId: friendStumbleId },
      { $pull: { friends: userStumbleId } }
    );
    return { success: true, message: "Amigo removido" };
  }

  static async getFriendsData(stumbleId) {
    const user = await this.findByStumbleId(stumbleId);
    if (!user) return null;
    const friendsList = await database.collections.Users.find({
      stumbleId: { $in: user.friends || [] }
    }).project({
      stumbleId: 1,
      username: 1,
      country: 1,
      userProfile: 1,
      lastLogin: 1
    }).toArray();
    const pendingRequests = await database.collections.Users.find({
      stumbleId: { $in: user.receivedFriendRequests || [] }
    }).project({
      stumbleId: 1,
      username: 1,
      country: 1,
      userProfile: 1
    }).toArray();
    return {
      friends: friendsList,
      pendingRequests: pendingRequests,
      sentRequestsCount: (user.sentFriendRequests || []).length
    };
  }
}

async function authenticate(req, res, next) {
  try {
    const authHeader = req.headers.authorization;
    req.user = null;
    if (!authHeader) {
      return next();
    }
    let authData;
    try {
      authData = JSON.parse(authHeader);
    } catch (e) {
      return next();
    }
    const { DeviceId, StumbleId } = authData;
    const user = StumbleId
      ? await UserModel.findByStumbleId(StumbleId)
      : await UserModel.findByDeviceId(DeviceId);
    req.user = user;
    next();
  } catch (err) {
    console.error('Auth error:', err);
    res.status(500).json({ error: 'Server error' });
  }
}

async function generatePhotonJwt(user) {
  const payload = {
    stumbleId: user.stumbleId,
    deviceId: user.deviceId,
    username: user.username
  };
  const secret = process.env.LeagueSalt;
  const options = { expiresIn: '30d', issuer: 'StumbleLeaguePhoton' };
  return new Promise((resolve, reject) => {
    jwt.sign(payload, secret, options, (err, token) => {
      if (err) reject(err);
      else resolve(token);
    });
  });
}

async function VerifyPhoton(req, res, user) {
  try {
    const tokenFromHeader = req.headers.authorization;
    if (!tokenFromHeader) {
      return res.json({ ResultCode: -1, Message: "Authorization header missing" });
    }
    try {
      const secret = process.env.LeagueSalt;
      const decoded = jwt.verify(tokenFromHeader, secret);
      if (decoded.stumbleId !== user.stumbleId ||
          decoded.deviceId !== user.deviceId ||
          decoded.username !== user.username) {
        return res.json({ ResultCode: -1, Message: "Token validation failed" });
      }
      return res.json({ ResultCode: 1, UserId: tokenFromHeader });
    } catch (err) {
      return res.json({ ResultCode: -1, Message: "Invalid token" });
    }
  } catch (err) {
    Console.error("VerifyPhoon", "Error:", err);
    return res.status(500).json({ ResultCode: -1, Message: "Internal server error" });
  }
}

class UserController {
  static async login(req, res) {
    try {
      const { DeviceId, StumbleId, SteamTicket, ScopelyId, Version } = req.body;
      if (!DeviceId) {
        return res.status(400).json({ message: 'DeviceId is required' });
      }
      let user = null;
      if (StumbleId) {
        user = await UserModel.findByStumbleId(StumbleId);
      }
      if (!user) {
        user = await UserModel.findByDeviceId(DeviceId);
      }
      if (!user) {
        Console.log("Login", "Criando novo usuario com o deviceId: " + DeviceId);
        user = await UserModel.create(DeviceId, { steamTicket: SteamTicket, scopelyId: ScopelyId, Version });
      }
      const photonJwt = await generatePhotonJwt(user);
      if (user.isBanned) {
        return res.status(403).send("BANNED");
      }
      return res.status(200).json({
        User: user,
        PhotonJwt: photonJwt,
        equippedCosmetics: user.equippedCosmetics
      });
    } catch (err) {
      Console.error('Login', 'Error:', err);
      return res.status(500).json({ message: 'Internal server error during login' });
    }
  }

  static async getConfig(req, res) {
    try {
      const config = {
        _SharedVersion: 2,
        Versions: {
          AndroidLastVersionAvailable: 0.59
        },
        BattlePassRotation: SharedData.BattlePassRotation || [],
        BattlePassesV3: SharedData.BattlePasses || [],
        RoundLevels_v2: SharedData.RoundLevels_v2 || [],
        Skins_v4: SharedData.Skins_v4 || [],
        MissionObjectives: SharedData.MissionObjectives || [],
        PurchasableItems: SharedData.PurchasableItems || [],
        GameEvents: SharedData.GameEvents || [],
        Animations: SharedData.Animations || [],
        Animations_v2: SharedData.Animations_v2 || [],
        AdSettings: SharedData.AdSettings || {},
        AnalyticsSettings: SharedData.AnalyticsSettings || {},
        BackendUrl: SharedData.BackendUrl || "",
        BattlePass: SharedData.BattlePass || {},
        ActionEmotes: SharedData.ActionEmotes || {},
        RankedPlaySettings: SharedData.RankedPlaySettings || {}
      };
      res.json(config);
    } catch (err) {
      Console.error('Config', 'Error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async updateUsername(req, res) {
    try {
      const { Username } = req.body;
      const { user } = req;
      if (!/^[a-zA-Z0-9_ .>]+$/.test(Username)) {
        res.status(422).json({ message: 'Username can only contain letters, numbers, and underscores' });
        return;
      }
      const existingUser = await database.getUserByQuery({ username: Username });
      if (existingUser) {
        res.status(409).json({ message: 'Username already taken' });
        return;
      }
      const updatedUser = await UserModel.update(user.stumbleId, { username: Username });
      res.status(200).json({ User: updatedUser });
    } catch (err) {
      console.error('Username', 'Update error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async getSettings(req, res) {
    try {
      const settings = {
        friendIsOnlinePush: true,
        invitedToPartyPush: true,
        partyInviteToastNotification: true,
        partyInviteInGameToastNotification: true
      };
      res.json(settings);
    } catch (err) {
      Console.error('Settings', 'Error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async getProfile(req, res) {
    try {
      const { userID } = req.body;
      let user = null;
      if (userID) {
        user = await UserModel.findById(userID);
      }
      if (!user) {
        return res.status(404).json({ message: 'User not found' });
      }
      res.json({ User: user.userProfile });
    } catch (err) {
      Console.error('Profile', 'Get error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async addSkin(req, res) {
    try {
      const { user } = req;
      const { skinId } = req.body;
      if (!skinId) {
        return res.status(400).json({ message: 'skinId is required' });
      }
      await UserModel.addSkin(user.stumbleId, skinId);
      const updatedUser = await UserModel.findByStumbleId(user.stumbleId);
      res.json({ User: updatedUser });
    } catch (err) {
      Console.error('Cosmetics', 'Add skin error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async setEquippedCosmetic(req, res) {
    try {
      const { user } = req;
      const { cosmeticType, cosmeticId } = req.body;
      if (!cosmeticType || !cosmeticId) {
        return res.status(400).json({ message: 'Both cosmeticType and cosmeticId are required' });
      }
      const updatedUser = await UserModel.setEquippedCosmetic(user.stumbleId, cosmeticType, cosmeticId);
      res.json({ User: updatedUser });
    } catch (err) {
      Console.error('Cosmetics', 'Set equipped error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async updateCosmetics(req, res) {
    try {
      const { user } = req;
      const {
        skin, color, animation, footsteps,
        emote1, emote2, emote3, emote4,
        actionEmote1, actionEmote2, actionEmote3, actionEmote4
      } = req.body;
      const updates = {
        equippedCosmetics: {
          skin: skin || user.equippedCosmetics.skin,
          color: color || user.equippedCosmetics.color,
          animation: animation || user.equippedCosmetics.animation,
          footsteps: footsteps || user.equippedCosmetics.footsteps,
          emote1: emote1 || user.equippedCosmetics.emote1,
          emote2: emote2 || user.equippedCosmetics.emote2,
          emote3: emote3 || user.equippedCosmetics.emote3,
          emote4: emote4 || user.equippedCosmetics.emote4,
          actionEmote1: actionEmote1 || user.equippedCosmetics.actionEmote1,
          actionEmote2: actionEmote2 || user.equippedCosmetics.actionEmote2,
          actionEmote3: actionEmote3 || user.equippedCosmetics.actionEmote3,
          actionEmote4: actionEmote4 || user.equippedCosmetics.actionEmote4
        }
      };
      const updatedUser = await UserModel.update(user.stumbleId, updates);
      res.json({ User: updatedUser });
    } catch (err) {
      Console.error('Cosmetics', 'Update error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async deleteAccount(req, res) {
    try {
      const { user } = req;
      const newUsername = `#${BackendUtils.GenCaracters(11)}`;
      await UserModel.update(user.deviceId, { username: newUsername });
      await database.collections.Users.deleteOne({ deviceId: user.deviceId });
      res.json({ message: 'Account deleted successfully' });
    } catch (err) {
      Console.error('Account', 'Delete error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async linkPlatform(req, res) {
    try {
      const { platform, platformId } = req.body;
      const { user } = req;
      const validPlatforms = ['google', 'apple', 'facebook', 'scopely'];
      if (!validPlatforms.includes(platform)) {
        return res.status(400).json({ message: 'Invalid platform' });
      }
      const platformIdMD5 = BackendUtils.Hash('md5', platformId || `${platform}-${user.username}-${process.env.LeagueSalt}`);
      const updateField = `${platform}Id`;
      const updatedUser = await UserModel.update(user.deviceId, { [updateField]: platformIdMD5 });
      res.json({ User: updatedUser, message: `Successfully linked ${platform} account` });
    } catch (err) {
      Console.error('Platform', 'Link error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async unlinkPlatform(req, res) {
    try {
      const { platform } = req.body;
      const { user } = req;
      const validPlatforms = ['google', 'apple', 'facebook', 'scopely'];
      if (!validPlatforms.includes(platform)) {
        return res.status(400).json({ message: 'Invalid platform' });
      }
      const updateField = `${platform}Id`;
      const updatedUser = await UserModel.update(user.deviceId, { [updateField]: '' });
      res.json({ User: updatedUser, message: `Successfully unlinked ${platform} account` });
    } catch (err) {
      Console.error('Platform', 'Unlink error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }
}

class RoundController {
  static async finishRound(req, res) {
    try {
      const { user } = req;
      const { round } = req.params;
      if (!round) {
        return res.status(400).json({ message: 'Round is required' });
      }
      const rewards = {
        crowns: round === '3' ? 1 : 0,
        skillRating: round === '3' ? 20 : round === '2' ? 10 : 0,
        experience: 100
      };
      const updatedUser = await UserModel.update(user.deviceId, {
        crowns: user.crowns + rewards.crowns,
        skillRating: user.skillRating + rewards.skillRating,
        experience: user.experience + rewards.experience
      });
      res.status(200).json({ User: updatedUser, Rewards: rewards });
    } catch (err) {
      Console.error('Round', 'Finish error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async finishCustomRound(req, res) {
    try {
      const { user } = req;
      res.json({ User: user, message: 'Custom round finished successfully' });
    } catch (err) {
      Console.error('Round', 'Custom finish error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async finishRoundV4(req, res) {
    try {
      const { user } = req;
      const { round } = req.params;
      const { gameType, variantId } = req.body;
      const isTournament = gameType === 'tournament';
      const gameId = BackendUtils.createGameId(gameType === 'event' ? 'event' : 'regular');
      const levelIds = SharedData.RoundLevels_v2.map(level => level.LevelID).slice(0, 3);
      const roundPayloads = {};
      const placements = {};
      const usersLastRound = {};

      if (round === '1') {
        placements[user.id] = isTournament ? 1 : 16;
        usersLastRound[user.id] = 1;
        roundPayloads[1] = {
          EliminatedPlayers: isTournament ? [] : [user.id, ...Array(15).fill(0).map((_, i) => 1000 + i)],
          LevelId: levelIds[0],
          Placements: placements,
          RoundMissionProgression: null,
          Type: "SoloRound"
        };
      } else if (round === '2') {
        placements[user.id] = isTournament ? 1 : 8;
        usersLastRound[user.id] = 2;
        roundPayloads[1] = { EliminatedPlayers: [], LevelId: levelIds[0], Placements: placements, RoundMissionProgression: null, Type: "SoloRound" };
        roundPayloads[2] = {
          EliminatedPlayers: isTournament ? [] : [user.id, ...Array(7).fill(0).map((_, i) => 1000 + i)],
          LevelId: levelIds[1], Placements: placements, RoundMissionProgression: null, Type: "SoloRound"
        };
      } else if (round === '3') {
        placements[user.id] = 1;
        usersLastRound[user.id] = 3;
        roundPayloads[1] = { EliminatedPlayers: [], LevelId: levelIds[0], Placements: placements, RoundMissionProgression: null, Type: "SoloRound" };
        roundPayloads[2] = { EliminatedPlayers: [], LevelId: levelIds[1], Placements: placements, RoundMissionProgression: null, Type: "SoloRound" };
        roundPayloads[3] = { EliminatedPlayers: [], LevelId: levelIds[2], Placements: placements, RoundMissionProgression: null, Type: "SoloRound" };
      }

      const clientViewPayload = {
        AverageMmr: null,
        CurrentRound: parseInt(round),
        ExpectedRounds: 3,
        FrameNumber: 7814,
        GameId: gameId,
        GameType: gameType === 'event' ? "Event" : "Regular",
        Placements: null,
        RoundPayloads: roundPayloads,
        StartingUsers: 2,
        UsersLastRound: usersLastRound,
        VariantId: variantId || null
      };

      const rewards = {
        crowns: round === '3' ? 1 : 0,
        skillRating: round === '3' ? 20 : round === '2' ? 10 : 0,
        experience: 100
      };

      const updatedUser = req.body._updatedUser || await UserModel.update(user.deviceId, {
        crowns: user.crowns + rewards.crowns,
        skillRating: user.skillRating + rewards.skillRating,
        experience: user.experience + rewards.experience
      });

      res.status(200).json({
        ClientViewPayload: clientViewPayload,
        ClientViewPlacements: null,
        FriendsCount: 0,
        LevelIds: levelIds,
        MissionsProgression: {},
        SignedPayload: "",
        User: updatedUser,
        Rewards: rewards
      });
    } catch (err) {
      Console.error('Round', 'FinishV4 error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }
}

class BattlePassController {
  static async getBattlePass(req, res) {
    try {
      const now = new Date();
      const activePass = SharedData.BattlePassRotation.find(pass => {
        const startDate = new Date(pass.StartDate);
        const endDate = new Date(pass.EndDate);
        return startDate <= now && now <= endDate;
      });
      if (!activePass) {
        return res.status(404).json({ message: 'No active battle pass found' });
      }
      const battlePass = SharedData.BattlePasses.find(bp => bp.PassID === activePass.PassID);
      if (!battlePass) {
        return res.status(404).json({ message: 'Battle pass data not found' });
      }
      res.json([battlePass]);
    } catch (err) {
      Console.error('BattlePass', 'Get error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async claimReward(req, res) {
    try {
      const { user } = req;
      const { Page, Section, Slot, IsPremium } = req.body;
      if (Page === undefined || Section === undefined || Slot === undefined) {
        return res.status(400).json({ message: 'Page, Section and Slot are required' });
      }
      const slotKey = `${Page},${Section},${Slot}`;
      if (user.battlePass.slotsClaimed.includes(slotKey)) {
        return res.status(400).json({ message: 'Slot already claimed' });
      }
      await database.collections.Users.updateOne(
        { deviceId: user.deviceId },
        { $push: { 'battlePass.slotsClaimed': slotKey } }
      );
      const updatedUser = await UserModel.findByDeviceId(user.deviceId);
      res.json({ User: updatedUser });
    } catch (err) {
      Console.error('BattlePass', 'Claim error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async purchaseBattlePass(req, res) {
    try {
      const { user } = req;
      if (user.battlePass.hasPurchased) {
        return res.status(400).json({ message: 'Battle pass already purchased' });
      }
      const gemsBalance = UserModel.getBalanceAmount(user, 'gems');
      if (gemsBalance < 1200) {
        return res.status(400).json({ message: 'Not enough gems' });
      }
      await UserModel.removeBalance(user.deviceId, 'gems', 1200);
      await UserModel.update(user.deviceId, { 'battlePass.hasPurchased': true });
      const updatedUser = await UserModel.findByDeviceId(user.deviceId);
      res.json({ User: updatedUser });
    } catch (err) {
      Console.error('BattlePass', 'Purchase error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async completeBattlePass(req, res) {
    try {
      const { user } = req;
      const battlePass = SharedData.BattlePasses[0];
      if (!battlePass) {
        return res.status(404).json({ message: 'No battle pass data available' });
      }
      const claimedSlots = user.battlePass.slotsClaimed || [];
      const userCoins = user.battlePass.coins || 0;
      const userExperience = user.battlePass.experience || 0;
      const xpToLevelUp = battlePass.XPToLevelUp || 1000;
      const playerLevel = Math.floor(userExperience / xpToLevelUp);
      for (const [pageIndex, page] of battlePass.Content.Pages.entries()) {
        for (const [sectionIndex, section] of page.Sections.entries()) {
          const sectionUnlockLevel = section.UnlockLevel || 0;
          if (playerLevel >= sectionUnlockLevel) {
            for (const [slotIndex, slot] of section.Slots.entries()) {
              const slotKey = `${pageIndex},${sectionIndex},${slotIndex}`;
              if (!claimedSlots.includes(slotKey)) {
                if (userCoins >= slot.UnlockCost && (!slot.IsPremium || user.battlePass.hasPurchased)) {
                  await database.collections.Users.updateOne(
                    { deviceId: user.deviceId },
                    { $push: { 'battlePass.slotsClaimed': slotKey } }
                  );
                }
              }
            }
          }
        }
      }
      const updatedUser = await UserModel.findByDeviceId(user.deviceId);
      res.json({ User: updatedUser });
    } catch (err) {
      Console.error('BattlePass', 'Complete error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }
}

class EconomyController {
  static async purchase(req, res) {
    try {
      const { user } = req;
      const itemId = req.params.item;
      const item = SharedData.PurchasableItems.find(i => i.Name === itemId);
      if (!item) return res.status(404).json({ error: 'ITEM_NOT_FOUND' });
      const price = item.Prices[0];
      if (!price) return res.status(400).json({ error: 'INVALID_PRICE' });
      const balance = UserModel.getBalanceAmount(user, price.Currency);
      if (balance < price.Amount) return res.status(402).json({ error: 'INSUFFICIENT_FUNDS' });
      await UserModel.removeBalance(user.stumbleId, price.Currency, price.Amount);
      const rewards = [];
      if (item.Rewards) {
        for (const reward of item.Rewards) {
          if (reward.Type === 'Currency') {
            await UserModel.addBalance(user.stumbleId, reward.CurrencyType, reward.Amount);
            rewards.push({ type: 'CURRENCY', currencyType: reward.CurrencyType, amount: reward.Amount });
          } else if (reward.Type === 'Cosmetic') {
            await UserModel.addSkin(user.stumbleId, reward.CosmeticId);
            rewards.push({ type: 'COSMETIC', cosmeticType: reward.CosmeticType, cosmeticId: reward.CosmeticId });
          }
        }
      }
      const updatedUser = await UserModel.findByStumbleId(user.stumbleId);
      res.json({ success: true, user: updatedUser, rewards });
    } catch (err) {
      Console.error('Economy', 'Purchase error:', err);
      res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
  }

  static async purchaseGasha(req, res) {
    try {
      const { user } = req;
      const { itemId } = req.params;
      const gashaItem = SharedData.PurchasableItems.find(i => i.Name === itemId && i.Type === 'Gasha');
      if (!gashaItem) return res.status(404).json({ error: 'GASHA_NOT_FOUND' });
      const price = gashaItem.Prices[0];
      if (!price || price.Currency !== 'Gems') return res.status(400).json({ error: 'INVALID_PRICE' });
      const userGems = UserModel.getBalanceAmount(user, 'Gems');
      if (userGems < price.Amount) return res.status(402).json({ error: 'INSUFFICIENT_GEMS' });
      await UserModel.removeBalance(user.stumbleId, 'Gems', price.Amount);
      const rewards = [];
      const possibleDrops = gashaItem.GashaDrops || [];
      const totalWeight = possibleDrops.reduce((sum, drop) => sum + drop.Weight, 0);
      for (let i = 0; i < (gashaItem.RollCount || 1); i++) {
        const roll = Math.random() * totalWeight;
        let weightSum = 0;
        for (const drop of possibleDrops) {
          weightSum += drop.Weight;
          if (roll <= weightSum) {
            if (drop.Type === 'Currency') {
              await UserModel.addBalance(user.stumbleId, drop.CurrencyType, drop.Amount);
              rewards.push({ type: 'CURRENCY', currencyType: drop.CurrencyType, amount: drop.Amount, rarity: drop.Rarity });
            } else if (drop.Type === 'Cosmetic') {
              await UserModel.addSkin(user.stumbleId, drop.CosmeticId);
              rewards.push({ type: 'COSMETIC', cosmeticType: drop.CosmeticType, cosmeticId: drop.CosmeticId, rarity: drop.Rarity });
            }
            break;
          }
        }
      }
      const updatedUser = await UserModel.findByStumbleId(user.stumbleId);
      res.json({ success: true, user: updatedUser, rewards, gashaId: gashaItem.Name });
    } catch (err) {
      Console.error('Economy', 'Gasha error:', err);
      res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
  }

  static async getLuckySpin(req, res) {
    try {
      const spinItem = SharedData.PurchasableItems.find(i => i?.Name === 'LuckySpin' || i?.Type === 'LuckySpin');
      if (!spinItem) return res.status(404).json({ error: 'SPIN_NOT_CONFIGURED' });
      const rewards = spinItem.SpinRewards || spinItem.spinRewards || spinItem.rewards || [];
      if (!Array.isArray(rewards) || rewards.length === 0) return res.status(500).json({ error: 'SPIN_REWARDS_EMPTY' });
      res.json({
        success: true,
        spinId: spinItem.Name,
        rewards: rewards.map(r => ({
          type: r.Type || r.type,
          currency: r.CurrencyType || null,
          cosmeticId: r.CosmeticId || null,
          amount: r.Amount || r.amount || null,
          weight: r.Weight || r.weight || 1,
          rarity: r.Rarity || 'COMMON'
        }))
      });
    } catch (err) {
      Console.error('Economy', 'GetLuckySpin error:', err);
      res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
  }

  static async purchaseLuckySpin(req, res) {
    try {
      const { user } = req;
      const spinItem = SharedData.PurchasableItems.find(i => i?.Name === 'LuckySpin' || i?.Type === 'LuckySpin' || i?.type === 'LuckySpin');
      if (!spinItem) return res.json({ success: false, error: 'SPIN_DISABLED' });
      const freeSpins = UserModel.getBalanceAmount(user, 'FreeSpins');
      const adSpins = UserModel.getBalanceAmount(user, 'AdSpins');
      if (freeSpins <= 0 && adSpins <= 0) return res.status(402).json({ error: 'NO_SPINS_AVAILABLE' });
      const spinType = freeSpins > 0 ? 'FreeSpins' : 'AdSpins';
      await UserModel.removeBalance(user.stumbleId, spinType, 1);
      const rewardsList = spinItem.SpinRewards || spinItem.spinRewards || spinItem.rewards || [];
      if (!Array.isArray(rewardsList) || rewardsList.length === 0) return res.status(500).json({ error: 'SPIN_REWARDS_EMPTY' });
      const totalWeight = rewardsList.reduce((sum, r) => sum + (r.Weight || r.weight || 1), 0);
      const roll = Math.random() * totalWeight;
      let acc = 0;
      let selected = null;
      for (const r of rewardsList) {
        acc += (r.Weight || r.weight || 1);
        if (roll <= acc) { selected = r; break; }
      }
      if (!selected) return res.status(500).json({ error: 'SPIN_FAILED' });
      if (selected.Type === 'Currency' || selected.type === 'CURRENCY') {
        const currency = selected.CurrencyType || selected.currency || selected.typeInfo;
        const amount = selected.Amount || selected.amount || selected.max || 1;
        await UserModel.addBalance(user.stumbleId, currency, amount);
      }
      if (selected.Type === 'Cosmetic' || selected.type === 'COSMETIC') {
        const cosmeticId = selected.CosmeticId || selected.cosmeticId;
        if (cosmeticId) await UserModel.addSkin(user.stumbleId, cosmeticId);
      }
      const updatedUser = await UserModel.findByStumbleId(user.stumbleId);
      res.json({ success: true, spinType, reward: selected, user: updatedUser });
    } catch (err) {
      Console.error('Economy', 'Spin error:', err);
      res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
  }

  static async giveCurrency(req, res) {
    try {
      const { currencyType, amount } = req.params;
      const { user } = req;
      const validCurrencies = ['Gems', 'Gold', 'Dust', 'FreeSpins', 'AdSpins'];
      if (!validCurrencies.includes(currencyType)) return res.status(400).json({ error: 'INVALID_CURRENCY' });
      const parsedAmount = parseInt(amount);
      if (isNaN(parsedAmount)) return res.status(400).json({ error: 'INVALID_AMOUNT' });
      await UserModel.addBalance(user.stumbleId, currencyType, parsedAmount);
      const updatedUser = await UserModel.findByStumbleId(user.stumbleId);
      res.json({ success: true, user: updatedUser, currencyAdded: { type: currencyType, amount: parsedAmount } });
    } catch (err) {
      Console.error('Economy', 'GiveCurrency error:', err);
      res.status(500).json({ error: 'INTERNAL_SERVER_ERROR' });
    }
  }
}

class AnalyticsController {
  static async analytic(req, res) {
    try {
      const { user } = req;
      const { type, message } = req.body;
      if (!type || !message) return res.status(400).json({ message: 'Type and message are required' });
      await database.collections.Analytics.insertOne({ DeviceId: user.deviceId, type, message, timestamp: new Date() });
      res.status(200).json("OK");
    } catch (err) {
      Console.error("Analytics", "Error:", err);
      res.status(500).json("Error");
    }
  }
}

class FriendsController {
  static async add(req, res) {
    try {
      const { UserId } = req.body;
      const { user } = req;
      if (!UserId) return res.status(400).json({ ResultCode: -1, Message: 'UserId is required' });
      const friend = await UserModel.findById(UserId);
      if (!friend) return res.status(404).json({ ResultCode: -1, Message: 'User not found' });
      if (user.friends.includes(friend.stumbleId)) return res.status(409).json({ ResultCode: -1, Message: 'Already friends' });
      await database.collections.Users.updateOne({ stumbleId: user.stumbleId }, { $addToSet: { friends: friend.stumbleId } });
      await database.collections.Users.updateOne({ stumbleId: friend.stumbleId }, { $addToSet: { friends: user.stumbleId } });
      const updatedUser = await UserModel.findByStumbleId(user.stumbleId);
      return res.status(200).json({ ResultCode: 1, User: updatedUser.userProfile });
    } catch (err) {
      Console.error('Friends', 'Add error:', err);
      return res.status(500).json({ ResultCode: -1, Message: 'Internal server error' });
    }
  }

  static async request(req, res) {
    try {
      const { UserId } = req.body;
      const { user } = req;
      if (!UserId) return res.status(400).json({ ResultCode: -1, Message: 'UserId is required' });
      const toUser = await UserModel.findById(UserId);
      if (!toUser) return res.status(404).json({ ResultCode: -1, Message: 'User not found' });
      if (user.sentFriendRequests.includes(toUser.stumbleId)) return res.status(409).json({ ResultCode: -1, Message: 'Request already sent' });
      await database.collections.Users.updateOne({ stumbleId: user.stumbleId }, { $addToSet: { sentFriendRequests: toUser.stumbleId } });
      await database.collections.Users.updateOne({ stumbleId: toUser.stumbleId }, { $addToSet: { receivedFriendRequests: user.stumbleId } });
      const updatedUser = await UserModel.findByStumbleId(user.stumbleId);
      return res.status(200).json({ ResultCode: 1, User: updatedUser.userProfile });
    } catch (err) {
      Console.error('Friends', 'Request error:', err);
      return res.status(500).json({ ResultCode: -1, Message: 'Internal server error' });
    }
  }

  static async accept(req, res) {
    try {
      const { UserId } = req.body;
      const { user } = req;
      if (!UserId) return res.status(400).json({ ResultCode: -1, Message: 'UserId is required' });
      const fromUser = await UserModel.findById(UserId);
      if (!fromUser) return res.status(404).json({ ResultCode: -1, Message: 'User not found' });
      if (!user.receivedFriendRequests.includes(fromUser.stumbleId)) return res.status(404).json({ ResultCode: -1, Message: 'No friend request found' });
      await database.collections.Users.updateOne({ stumbleId: user.stumbleId }, { $pull: { receivedFriendRequests: fromUser.stumbleId }, $addToSet: { friends: fromUser.stumbleId } });
      await database.collections.Users.updateOne({ stumbleId: fromUser.stumbleId }, { $pull: { sentFriendRequests: user.stumbleId }, $addToSet: { friends: user.stumbleId } });
      const updatedUser = await UserModel.findByStumbleId(user.stumbleId);
      return res.status(200).json({ ResultCode: 1, User: updatedUser.userProfile });
    } catch (err) {
      Console.error('Friends', 'Accept error:', err);
      return res.status(500).json({ ResultCode: -1, Message: 'Internal server error' });
    }
  }

  static async reject(req, res) {
    try {
      const { UserId } = req.body;
      const { user } = req;
      if (!UserId) return res.status(400).json({ ResultCode: -1, Message: 'UserId is required' });
      const fromUser = await UserModel.findById(UserId);
      if (!fromUser) return res.status(404).json({ ResultCode: -1, Message: 'User not found' });
      if (!user.receivedFriendRequests.includes(fromUser.stumbleId)) return res.status(404).json({ ResultCode: -1, Message: 'No friend request found' });
      await database.collections.Users.updateOne({ stumbleId: user.stumbleId }, { $pull: { receivedFriendRequests: fromUser.stumbleId } });
      await database.collections.Users.updateOne({ stumbleId: fromUser.stumbleId }, { $pull: { sentFriendRequests: user.stumbleId } });
      const updatedUser = await UserModel.findByStumbleId(user.stumbleId);
      return res.status(200).json({ ResultCode: 1, User: updatedUser.userProfile });
    } catch (err) {
      Console.error('Friends', 'Reject error:', err);
      return res.status(500).json({ ResultCode: -1, Message: 'Internal server error' });
    }
  }

  static async cancel(req, res) {
    try {
      const { UserId } = req.body;
      const { user } = req;
      if (!UserId) return res.status(400).json({ ResultCode: -1, Message: 'UserId is required' });
      const toUser = await UserModel.findById(UserId);
      if (!toUser) return res.status(404).json({ ResultCode: -1, Message: 'User not found' });
      if (!user.sentFriendRequests.includes(toUser.stumbleId)) return res.status(404).json({ ResultCode: -1, Message: 'No friend request found' });
      await database.collections.Users.updateOne({ stumbleId: user.stumbleId }, { $pull: { sentFriendRequests: toUser.stumbleId } });
      await database.collections.Users.updateOne({ stumbleId: toUser.stumbleId }, { $pull: { receivedFriendRequests: user.stumbleId } });
      const updatedUser = await UserModel.findByStumbleId(user.stumbleId);
      return res.status(200).json({ ResultCode: 1, User: updatedUser.userProfile });
    } catch (err) {
      Console.error('Friends', 'Cancel error:', err);
      return res.status(500).json({ ResultCode: -1, Message: 'Internal server error' });
    }
  }

  static async list(req, res) {
    try {
      const { user } = req;
      const friends = await database.collections.Users.find({ stumbleId: { $in: user.friends || [] } }).project({ userProfile: 1 }).toArray();
      return res.status(200).json(friends.map(f => f.userProfile));
    } catch (err) {
      Console.error('Friends', 'List error:', err);
      return res.status(500).json({ ResultCode: -1, Message: 'Internal server error' });
    }
  }

  static async pending(req, res) {
    try {
      const { user } = req;
      const pendingUsers = await database.collections.Users.find({ stumbleId: { $in: user.receivedFriendRequests || [] } }).project({ userProfile: 1 }).toArray();
      return res.status(200).json(pendingUsers.map(u => u.userProfile));
    } catch (err) {
      Console.error('Friends', 'Pending error:', err);
      return res.status(500).json({ ResultCode: -1, Message: 'Internal server error' });
    }
  }

  static async remove(req, res) {
    try {
      const { UserId } = req.params;
      const { user } = req;
      if (!UserId) return res.status(400).json({ ResultCode: -1, Message: 'UserId is required' });
      const friend = await UserModel.findById(UserId);
      if (!friend) return res.status(404).json({ ResultCode: -1, Message: 'User not found' });
      if (!user.friends.includes(friend.stumbleId)) return res.status(404).json({ ResultCode: -1, Message: 'Not friends' });
      await database.collections.Users.updateOne({ stumbleId: user.stumbleId }, { $pull: { friends: friend.stumbleId } });
      await database.collections.Users.updateOne({ stumbleId: friend.stumbleId }, { $pull: { friends: user.stumbleId } });
      const updatedUser = await UserModel.findByStumbleId(user.stumbleId);
      return res.status(200).json({ ResultCode: 1, User: updatedUser.userProfile });
    } catch (err) {
      Console.error('Friends', 'Remove error:', err);
      return res.status(500).json({ ResultCode: -1, Message: 'Internal server error' });
    }
  }

  static async search(req, res) {
    try {
      let { UserName } = req.body;
      if (!UserName) return res.status(400).json({ ResultCode: -1, Message: 'UserName is required' });
      UserName = UserName.trim();
      if (UserName.length < 3) return res.status(400).json({ ResultCode: -1, Message: 'UserName must be at least 3 characters' });
      Console.log('Friends', `Searching for username: "${UserName}"`);
      const user = await database.collections.Users.findOne({
        $or: [
          { username: { $regex: `^${UserName}$`, $options: 'i' } },
          { premiumUsername: { $regex: `^${UserName}$`, $options: 'i' } },
          { adminUsername: { $regex: `^${UserName}$`, $options: 'i' } }
        ]
      }).project({ userProfile: 1, username: 1, premiumUsername: 1, adminUsername: 1 });
      if (!user) return res.status(404).json({ ResultCode: -1, Message: 'User not found' });
      let userProfile = user.userProfile;
      if (!userProfile) {
        userProfile = {
          userId: user.id || user._id,
          userName: user.premiumUsername || user.adminUsername || user.username || 'Unknown',
          country: user.country || 'BR',
          trophies: user.skillRating || 0,
          crowns: user.crowns || 0,
          experience: user.experience || 0,
          hiddenRating: Math.floor((user.skillRating || 0) / 10),
          isOnline: true,
          lastSeenDate: user.lastLogin ? user.lastLogin.toISOString() : new Date().toISOString(),
          skin: user.equippedCosmetics?.skin || 'SKIN1',
          nativePlatformName: "android",
          ranked: { currentSeasonId: "LIVE_RANKED_SEASON_12", currentRankId: 0, currentTierIndex: 0 },
          flags: 0
        };
      } else {
        userProfile.userName = user.premiumUsername || user.adminUsername || user.username || userProfile.userName;
      }
      return res.status(200).json({ ResultCode: 1, User: userProfile });
    } catch (err) {
      Console.error('Friends', 'Search error:', err);
      return res.status(500).json({ ResultCode: -1, Message: 'Internal server error' });
    }
  }
}

class NewsController {
  static async GetNews(req, res) {
    try {
      const newsList = await database.collections.News.find().sort({ timestamp: -1 }).toArray();
      const news = newsList.map(news => ({ Header: news.header, Message: news.message, TimeStamp: news.timestamp }));
      res.json(news);
    } catch (err) {
      Console.error('News', 'Get error:', err);
      res.status(500).json({ message: 'Error fetching news' });
    }
  }
}

class MissionsController {
  static async getMissions(req, res) {
    try {
      const { user } = req;
      const missions = SharedData.MissionObjectives.map(mission => ({
        missionId: mission.Id,
        missionActive: true,
        rewardsClaimed: false,
        requirementProgressions: mission.Requirements.map(req => ({
          requirementId: req.Id,
          completed: Math.random() > 0.5,
          current: Math.floor(Math.random() * req.Target),
          target: req.Target
        }))
      }));
      res.json({
        missionObjectiveProgressionUpdated: {
          missionObjectiveId: "daily",
          currentPoints: Math.floor(Math.random() * 100),
          milestoneProgressions: SharedData.MissionObjectives.find(m => m.Id === "daily")?.Milestones.map(milestone => ({ milestoneId: milestone.MilestoneId, claimed: false })) || []
        },
        missionsProgressionsUpdated: missions
      });
    } catch (err) {
      Console.error('Missions', 'Get error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async claimMissionReward(req, res) {
    try {
      const { user } = req;
      const { missionId } = req.params;
      const mission = SharedData.MissionObjectives.flatMap(m => m.Requirements.map(r => ({ ...r, missionId: m.Id }))).find(m => m.missionId === missionId);
      if (!mission) return res.status(404).json({ message: 'Mission not found' });
      const rewards = mission.Rewards || [];
      for (const reward of rewards) {
        if (reward.type === 'CURRENCY') await UserModel.addBalance(user.deviceId, reward.typeInfo, reward.amount);
      }
      const updatedUser = await UserModel.findByDeviceId(user.deviceId);
      res.json({ User: updatedUser, Rewards: rewards, message: 'Rewards claimed successfully' });
    } catch (err) {
      Console.error('Missions', 'Claim error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async claimMilestoneReward(req, res) {
    try {
      const { user } = req;
      const { objectiveId, milestoneId } = req.params;
      const objective = SharedData.MissionObjectives.find(m => m.Id === objectiveId);
      if (!objective) return res.status(404).json({ message: 'Objective not found' });
      const milestone = objective.Milestones.find(m => m.MilestoneId === milestoneId);
      if (!milestone) return res.status(404).json({ message: 'Milestone not found' });
      const rewards = milestone.Rewards || [];
      for (const reward of rewards) {
        if (reward.type === 'CURRENCY') await UserModel.addBalance(user.deviceId, reward.typeInfo, reward.amount);
      }
      const updatedUser = await UserModel.findByDeviceId(user.deviceId);
      res.json({ User: updatedUser, Rewards: rewards, message: 'Milestone rewards claimed successfully' });
    } catch (err) {
      Console.error('Missions', 'Claim milestone error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }
}

class TournamentXController {
  static tournaments = [
    {
      id: 1, type: 1, isEnabled: true, minVersion: "0.56",
      startTime: new Date(), endTime: new Date(Date.now() + 5 * 365 * 24 * 60 * 60 * 1000),
      nameKey: " BlockDash 1v1", descriptionKey: ".GG/SGPRISM",
      listItemBackgroundImage: "Event_Lobby_Item_Background_Rolling_Towers",
      detailsPanelBackgroundImage: "Event_Lobby_Item_Background_Rolling_Towers",
      prizeBannerColour: "#747474", headerColour: "#747474",
      mapListGradientColourTop: "#747474", mapListGradientColourBottom: "#747474",
      listPriority: 0, minPlayers: 2, maxPlayers: 2, maxRounds: 1, hasBots: false,
      minMatchmakingSeconds: 5, entryCurrencyType: "gems", entryCurrencyCost: 0,
      entryCurrencyType2: "dust", entryCurrencyCost2: 0,
      areEmotesRestricted: true, prohibitedEmotes: [8, 13, 156, 123, 124, 174],
      detailsPanelBorderColourTop: "#747474", detailsPanelBorderColourBottom: "#D34286",
      colourData: { detailsPanelMainColour: "#747474", detailsPanelBorderColour: "#747474", headerGradientRight: "#747474", headerGradientLeft: "#747474", infoWidgetsGradientRight: "#747474", infoWidgetsGradientLeft: "#747474", infoWidgetsBorderColour: "#747474" },
      rounds: [{ roundOrder: 1, maxPlayersToProgress: 1, minPlayersPerMatch: 2, maxPlayersPerMatch: 2, areLevelsRestricted: true, permittedLevels: ["level19_block"] }],
      awards: [{ placementRangeLowest: 2, placementRangeHighest: 2, awardId: 12, type: "CURRENCY", amount: 100, awardJson: { name: "gems" } }],
      players: [], partys: []
    },
    {
      id: 2, type: 1, isEnabled: true, minVersion: "0.56",
      startTime: new Date(), endTime: new Date(Date.now() + 5 * 365 * 24 * 60 * 60 * 1000),
      nameKey: "Legendary 1v1", descriptionKey: ".GG/SGECHO",
      listItemBackgroundImage: "Event_Lobby_Item_Background_Rolling_Towers",
      detailsPanelBackgroundImage: "Event_Lobby_Item_Background_Rolling_Towers",
      prizeBannerColour: "#747474", headerColour: "#747474",
      mapListGradientColourTop: "#747474", mapListGradientColourBottom: "#747474",
      listPriority: 0, minPlayers: 2, maxPlayers: 2, maxRounds: 1, hasBots: false,
      minMatchmakingSeconds: 5, entryCurrencyType: "gems", entryCurrencyCost: 0,
      entryCurrencyType2: "dust", entryCurrencyCost2: 0,
      areEmotesRestricted: false, prohibitedEmotes: [8, 13, 156, 123, 124, 174],
      detailsPanelBorderColourTop: "#747474", detailsPanelBorderColourBottom: "#747474",
      colourData: { detailsPanelMainColour: "#747474", detailsPanelBorderColour: "#747474", headerGradientRight: "#747474", headerGradientLeft: "#747474", infoWidgetsGradientRight: "#747474", infoWidgetsGradientLeft: "#747474", infoWidgetsBorderColour: "#747474" },
      rounds: [{ roundOrder: 1, maxPlayersToProgress: 1, minPlayersPerMatch: 2, maxPlayersPerMatch: 2, areLevelsRestricted: true, permittedLevels: ["eventlevel13_block_legendary"] }],
      awards: [{ placementRangeLowest: 2, placementRangeHighest: 2, awardId: 12, type: "CURRENCY", amount: 100, awardJson: { name: "gems" } }],
      players: [], partys: []
    },
    {
      id: 3, type: 2, isEnabled: true, minVersion: "0.56",
      startTime: new Date(), endTime: new Date(Date.now() + 5 * 365 * 24 * 60 * 60 * 1000),
      nameKey: "LavaLand 1v1", descriptionKey: ".GG/SGPRISM",
      listItemBackgroundImage: "Event_Lobby_Item_Background_Rolling_Towers",
      detailsPanelBackgroundImage: "Event_Lobby_Item_Background_Rolling_Towers",
      prizeBannerColour: "#747474", headerColour: "#747474",
      mapListGradientColourTop: "#747474", mapListGradientColourBottom: "#747474",
      listPriority: 1, minPlayers: 2, maxPlayers: 2, maxRounds: 1, hasBots: false,
      minMatchmakingSeconds: 5, entryCurrencyType: "gems", entryCurrencyCost: 0,
      entryCurrencyType2: "dust", entryCurrencyCost2: 0,
      areEmotesRestricted: false, prohibitedEmotes: [8, 9, 13, 85, 156, 123, 124, 174],
      detailsPanelBorderColourTop: "#747474", detailsPanelBorderColourBottom: "#747474",
      colourData: { detailsPanelMainColour: "#747474", detailsPanelBorderColour: "#747474", headerGradientRight: "#747474", headerGradientLeft: "#747474", infoWidgetsGradientRight: "#747474", infoWidgetsGradientLeft: "#747474", infoWidgetsBorderColour: "#747474" },
      rounds: [{ roundOrder: 1, maxPlayersToProgress: 1, minPlayersPerMatch: 2, maxPlayersPerMatch: 2, areLevelsRestricted: true, permittedLevels: ["level21_pillar"] }],
      awards: [{ placementRangeLowest: 2, placementRangeHighest: 2, awardId: 12, type: "CURRENCY", amount: 65, awardJson: { name: "gems" } }],
      players: [], partys: []
    },
    {
      id: 4, type: 3, isEnabled: true, minVersion: "0.56",
      startTime: new Date(), endTime: new Date(Date.now() + 5 * 365 * 24 * 60 * 60 * 1000),
      nameKey: "Laser Tracer 1v1", descriptionKey: ".GG/SGECHO",
      listItemBackgroundImage: "Event_Lobby_Item_Background_Rolling_Towers",
      detailsPanelBackgroundImage: "Event_Lobby_Item_Background_Rolling_Towers",
      prizeBannerColour: "#747474", headerColour: "#747474",
      mapListGradientColourTop: "#747474", mapListGradientColourBottom: "#747474",
      listPriority: 1, minPlayers: 2, maxPlayers: 2, maxRounds: 1, hasBots: false,
      minMatchmakingSeconds: 5, entryCurrencyType: "gems", entryCurrencyCost: 0,
      entryCurrencyType2: "dust", entryCurrencyCost2: 0,
      areEmotesRestricted: false, prohibitedEmotes: [8, 9, 13, 85, 156, 123, 124, 174],
      detailsPanelBorderColourTop: "#747474", detailsPanelBorderColourBottom: "#747474",
      colourData: { detailsPanelMainColour: "#747474", detailsPanelBorderColour: "#747474", headerGradientRight: "#747474", headerGradientLeft: "#747474", infoWidgetsGradientRight: "#747474", infoWidgetsGradientLeft: "#747474", infoWidgetsBorderColour: "#747474" },
      rounds: [{ roundOrder: 1, maxPlayersToProgress: 1, minPlayersPerMatch: 2, maxPlayersPerMatch: 2, areLevelsRestricted: true, areEmotesRestricted: true, prohibitedEmotes: [8, 9, 13, 85, 156, 123, 124, 174], permittedLevels: ["level15_laser"] }],
      awards: [{ placementRangeLowest: 2, placementRangeHighest: 2, awardId: 12, type: "CURRENCY", amount: 65, awardJson: { name: "gems" } }],
      players: [], partys: []
    }
  ];

  static getActive(req, res) {
    try {
      console.log("TournamentXController.getActive called - returning tournaments:", TournamentXController.tournaments.length);
      res.status(200).json(TournamentXController.tournaments);
    } catch (err) {
      console.error("erro:", err);
      res.status(500).json({ message: "erro interno" });
    }
  }

  static async join(req, res) {
    try {
      const { user } = req;
      const tournamentId = parseInt(req.params.tournamentId);
      console.log("TournamentXController.join called - tournamentId:", tournamentId, "user:", user?.stumbleId);
      const tournament = TournamentXController.tournaments.find(t => t.id === tournamentId);
      if (!tournament) return res.status(404).json({ message: "torneio nao encontrado" });
      if (!tournament.isEnabled) return res.status(400).json({ message: "torneio desativado" });
      const now = new Date();
      if (now < tournament.startTime || now > tournament.endTime) return res.status(400).json({ message: "torneio nao esta ativo no momento" });
      if (tournament.entryCurrencyCost > 0) {
        const userBalance = UserModel.getBalanceAmount(user, tournament.entryCurrencyType);
        if (userBalance < tournament.entryCurrencyCost) return res.status(400).json({ message: `saldo insuficiente de ${tournament.entryCurrencyType}` });
        await UserModel.removeBalance(user.deviceId, tournament.entryCurrencyType, tournament.entryCurrencyCost);
      }
      tournament.players.push({ stumbleId: user.stumbleId, userId: user.id, username: user.username });
      const entryToken = `tournament-${tournament.id}-${Date.now()}`;
      if (!Array.isArray(tournament.partys)) tournament.partys = [];
      const maxPlayers = tournament.maxPlayers || 2;
      let partyId, MatchmakerTag, found = false;
      for (const partyList of tournament.partys) {
        for (const party of partyList) {
          if (party.players.length < maxPlayers) {
            party.players.push(user.stumbleId);
            MatchmakerTag = party.partyId;
            partyId = party.partyId;
            found = true;
            break;
          }
        }
        if (found) break;
      }
      if (!found) {
        const newParty = { partyId: `tournament-${tournament.id}-${Math.floor(Math.random() * 9999)}`, players: [user.stumbleId] };
        tournament.partys.push([newParty]);
        MatchmakerTag = newParty.partyId;
        partyId = newParty.partyId;
      }
      console.log(`coloquei o ${user.username} (Ele tem o id ${user.stumbleId}) na partida ${partyId} no torneio ${tournament.nameKey} com id ${tournament.id} e token ${entryToken}`);
      res.status(200).json({ entryToken, MatchmakerTag, requestId: user.stumbleId });
    } catch (err) {
      console.error("erro ao entrar no torneio:", err);
      res.status(500).json({ message: "erro interno do servidor" });
    }
  }

  static async leave(req, res) {
    try {
      const { user } = req;
      const tournamentId = parseInt(req.params.tournamentId);
      const tournament = TournamentXController.tournaments.find(t => t.id === tournamentId);
      if (!tournament) return res.status(404).json({ message: "torneio nao encontrado" });
      const playerIndex = tournament.players.findIndex(p => p.stumbleId === user.stumbleId);
      if (playerIndex !== -1) {
        tournament.players.splice(playerIndex, 1);
        if (tournament.entryCurrencyCost > 0) await UserModel.addBalance(user.deviceId, tournament.entryCurrencyType, tournament.entryCurrencyCost);
      }
      res.status(200).json({ message: "saiu" });
    } catch (err) {
      console.error("tournamentx", "erro ao sair do torneio:", err);
      res.status(500).json({ message: "erro interno do servidor" });
    }
  }

  static async finish(req, res) {
    try {
      const { Round, TournamentId, EntryToken, SignedPayload } = req.body;
      const { user } = req;
      if (typeof Round === 'undefined') return res.status(400).json({ mensagem: "precisa do round" });
      if (!user || !user.stumbleId || !user.userProfile) return res.status(400).json({ mensagem: "user invalido" });
      const roundResult = parseInt(Round);
      if (isNaN(roundResult)) return res.status(400).json({ mensagem: "round invalido" });
      let gemsChange = 0, crownsChange = 0, pointsChange = 0;
      if (roundResult === 1) { gemsChange = 65; crownsChange = 1; pointsChange = 10; }
      else if (roundResult === 0) { crownsChange = -1; pointsChange = -10; gemsChange = -30; }
      const currentCrowns = parseInt(user.userProfile.crowns) || 0;
      const currentTrophies = parseInt(user.userProfile.trophies) || 0;
      const currentSkill = parseInt(user.skillRating) || 0;
      const updatedUserProfile = { ...user.userProfile, crowns: Math.max(0, currentCrowns + crownsChange), trophies: Math.max(0, currentTrophies + pointsChange) };
      await UserModel.update(user.stumbleId, { crowns: Math.max(0, currentCrowns + crownsChange), skillRating: Math.max(0, currentSkill + pointsChange), userProfile: updatedUserProfile });
      if (gemsChange > 0) await UserModel.addBalance(user.deviceId, "gems", gemsChange);
      console.log("Finalizei o round do " + user.username);
      const tournament = TournamentXController.tournaments.find(t => t.id === parseInt(TournamentId));
      const updatedUser = await UserModel.findByDeviceId(user.deviceId);
      req.params.round = String(roundResult);
      req.body.gameType = 'tournament';
      req.body.hasBots = typeof tournament?.hasBots === 'boolean' ? tournament.hasBots : false;
      req.body.skipRewards = false;
      req.body._updatedUser = updatedUser;
      req.body.areEmotesRestricted = true;
      req.body.prohibitedEmotes = tournament?.prohibitedEmotes;
      await RoundController.finishRoundV4(req, res);
    } catch (err) {
      console.error("erro ao finalizar round de tourx:", err);
      res.status(500).json({ mensagem: "erro interno do servidor" });
    }
  }
}

class MatchmakingController {
  static async getMatchmakingFilter(req, res) {
    try {
      const { deviceId } = req.query;
      if (!deviceId) return res.status(400).json({ error: "Bad Request", message: "deviceId query parameter is required" });
      const user = await UserModel.findByDeviceId(deviceId);
      if (!user) return res.status(404).json({ error: "Not Found", message: "User not found" });
      const sharedType = process.env.sharedType || 'NULL';
      const version = user.version || '0';
      const platform = user.userProfile?.nativePlatformName || 'null';
      const skillTier = Math.floor((user.skillRating || 0) / 1000);
      const regionCodes = ['na', 'eu', 'as', 'sa', 'af', 'oc', 'ae'];
      const region = regionCodes[Math.floor(Math.random() * regionCodes.length)];
      const matchmakingFilter = `${sharedType}_${version}_${platform}_${skillTier}_${region}`;
      return res.status(200).json({ matchmakingFilter });
    } catch (err) {
      Console.error('Matchmaking', 'Filter error:', err);
      return res.status(500).json({ error: "Internal Server Error", message: "An error occurred while generating matchmaking filter" });
    }
  }
}

class SocialController {
  static async getInteractions(req, res) {
    try {
      const { user } = req;
      const friendIds = user.friends || [];
      const friends = await database.collections.Users.find({ stumbleId: { $in: friendIds } })
        .project({ id: 1, username: 1, stumbleId: 1, country: 1, skillRating: 1, crowns: 1, experience: 1, 'equippedCosmetics.skin': 1, lastLogin: 1 })
        .toArray();
      const friendProfiles = friends.map(friend => ({
        userId: friend.id, userName: friend.username, title: "", country: friend.country,
        trophies: friend.skillRating, crowns: friend.crowns, experience: friend.experience,
        hiddenRating: Math.floor(friend.skillRating / 10), isOnline: true,
        lastSeenDate: friend.lastLogin.toISOString(), skin: friend.equippedCosmetics?.skin || 'SKIN1',
        nativePlatformName: "android", ranked: { currentSeasonId: "LIVE_RANKED_SEASON_12", currentRankId: 0, currentTierIndex: 0 }, flags: 0
      }));
      const receivedRequests = user.receivedFriendRequests || [];
      const pendingUsers = await database.collections.Users.find({ stumbleId: { $in: receivedRequests } })
        .project({ id: 1, username: 1, country: 1, skillRating: 1, crowns: 1, experience: 1, 'equippedCosmetics.skin': 1, lastLogin: 1 })
        .toArray();
      const friendRequestProfiles = pendingUsers.map(u => ({
        userId: u.id, userName: u.username, title: "", country: u.country,
        trophies: u.skillRating, crowns: u.crowns, experience: u.experience,
        hiddenRating: Math.floor(u.skillRating / 10), isOnline: true,
        lastSeenDate: u.lastLogin.toISOString(), skin: u.equippedCosmetics?.skin || 'SKIN1',
        nativePlatformName: "android", ranked: { currentSeasonId: "LIVE_RANKED_SEASON_12", currentRankId: 0, currentTierIndex: 0 }, flags: 0
      }));
      const recommendedUsers = await database.collections.Users.aggregate([
        { $match: { stumbleId: { $nin: [...friendIds, ...receivedRequests, user.stumbleId] }, country: { $exists: true } } },
        { $sample: { size: 5 } },
        { $project: { id: 1, username: 1, country: 1, skillRating: 1, crowns: 1, experience: 1, 'equippedCosmetics.skin': 1, lastLogin: 1 } }
      ]).toArray();
      const recommendedProfiles = recommendedUsers.map(u => {
        const tags = [];
        if (u.country === user.country) tags.push("SAME_COUNTRY");
        if (Math.abs((u.skillRating || 0) - (user.skillRating || 0)) < 200) tags.push("SIMILAR_SKILL");
        return {
          tags: tags.length > 0 ? tags : ["SIMILAR_SKILL"],
          userProfile: {
            userId: u.id, userName: u.username, title: "", country: u.country,
            trophies: u.skillRating, crowns: u.crowns, experience: u.experience,
            hiddenRating: Math.floor(u.skillRating / 10), isOnline: true,
            lastSeenDate: u.lastLogin.toISOString(), skin: u.equippedCosmetics?.skin || 'SKIN1',
            nativePlatformName: "android", ranked: { currentSeasonId: "LIVE_RANKED_SEASON_12", currentRankId: 0, currentTierIndex: 0 }, flags: 0
          }
        };
      });
      res.json({ friends: friendProfiles, friendRequests: friendRequestProfiles, partyInvites: [], recommendedFriends: recommendedProfiles });
    } catch (err) {
      Console.error('Social', 'Interactions error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }
}

class TournamentController {
  static async login(req, res) {
    try {
      const user = await UserModel.findByDeviceId(req.user.deviceId);
      const photonJwt = await generatePhotonJwt(user);
      return res.json({ User: user, PhotonJwt: photonJwt, equippedCosmetics: user.equippedCosmetics });
    } catch (error) {
      Console.error('TournamentLogin', error);
      return res.status(500).json({ message: 'Internal server error' });
    }
  }

  static async getActive(req, res) {
    try {
      const now = new Date();
      const activeTournaments = await database.collections.Tournaments.find({ startTime: { $lte: now }, endTime: { $gte: now }, isActive: true }).sort({ startTime: 1 }).toArray();
      res.json(activeTournaments);
    } catch (err) {
      Console.error('Tournament', 'Get active error:', err);
      res.status(500).json({ message: 'Internal server error' });
    }
  }
}

class EventsController {
  static async getActive(req, res) {
    try {
      const now = new Date();
      const activeEvents = (SharedData.GameEvents || []).filter(event => {
        const startDate = new Date(event.StartDateTime);
        const endDate = new Date(event.EndDateTime);
        return startDate <= now && now <= endDate;
      });
      res.json({ gameEvents: activeEvents });
    } catch (err) {
      Console.error('GameEvents', 'Error:', err);
      res.status(500).json([]);
    }
  }
}

function errorControll(err, req, res, next) {
  Console.error('Unhandled', 'Error:', err);
  res.status(500).json({ message: 'Internal server error' });
}

const { generateAuthPayload } = require("./SharedUtils");

async function sendShared(req, res) {
  try {
    const shared = generateAuthPayload();
    res.status(200).json(shared);
  } catch (err) {
    Console.error("sendShared", err);
    res.sendStatus(500);
  }
}

async function OnlineCheck(req, res) {
  res.status(200).send("OK");
}

module.exports = {
  BackendUtils,
  Database,
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
  errorControll,
  sendShared,
  OnlineCheck,
  VerifyPhoton,
  generatePhotonJwt
};
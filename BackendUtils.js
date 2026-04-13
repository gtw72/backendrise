const { MongoClient } = require('mongodb');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const dotenv = require('dotenv');
dotenv.config();

const Console = require("./ConsoleUtils");
const CryptoUtils = require("./CryptoUtils");
const SharedUtils = require("./SharedUtils.js");
const SharedData = require("./shared.json");

const BackendUtils = {
  generateId: () => crypto.randomBytes(16).toString('hex'),
  GenCaracters: (length) => crypto.randomBytes(Math.ceil(length / 2)).toString('hex').slice(0, length),
  createHash: (...args) => crypto.createHash('sha256').update(args.join('')).digest('hex'),
  getTimestamp: () => Math.floor(Date.now() / 1000),
};

class Database {
  constructor() {
    this.mongoUri = process.env.mongoUri;
    this.dbName = 'StumblePrism';
    this.client = null;
    this.db = null;
    this.collections = {
      Users: null,
      Counters: null,
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
    this.collections.Counters = this.db.collection("Counters");
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
    await this.initPlayerIdCounter();
    await this.autoPopulateSharedData();

    Console.log("Database", 'Connected to database');
  }

  async initPlayerIdCounter() {
    await this.collections.Counters.updateOne(
      { _id: "playerIdCounter" },
      { $setOnInsert: { seq: 0 } },
      { upsert: true }
    );
  }

  async createIndexes() {
    await this.collections.Users.createIndexes([
      { key: { deviceId: 1 }, unique: true, sparse: true },
      { key: { stumbleId: 1 }, unique: true, sparse: true },
      { key: { username: 1 }, unique: true, sparse: true },
      { key: { friends: 1 } },
      { key: { sentFriendRequests: 1 } },
      { key: { receivedFriendRequests: 1 } }
    ]);
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
      await this.collections.Users.updateOne(query, { $push: { balances: { name: currency, amount } } });
    }
    return result;
  }

  async createUser(userData) {
    const result = await this.collections.Users.insertOne(userData);
    return { ...userData, _id: result.insertedId };
  }

  async autoPopulateSharedData() { /* mantenha seu código original aqui */ }
}

const database = new Database();
database.connect().catch(err => {
  console.error('Database connection error:', err);
  process.exit(1);
});

class UserModel {

  // ====================== GERA ID SEQUENCIAL ======================
  static async generateSequentialPlayerId() {
    try {
      const counter = await database.collections.Counters.findOneAndUpdate(
        { _id: "playerIdCounter" },
        { $inc: { seq: 1 } },
        { upsert: true, returnDocument: 'after' }
      );
      const nextNumber = counter.value.seq || 1;
      return nextNumber.toString().padStart(3, '0');
    } catch (error) {
      Console.error('PlayerID', 'Erro ao gerar ID:', error);
      return '001';
    }
  }

  // ====================== CREATE USER ======================
  static async create(deviceId, platformData = {}) {
    const now = new Date();

    let existingUser = await database.collections.Users.findOne({ deviceId });
    if (existingUser) {
      Console.log("Login", `Usuário existente: ${existingUser.stumbleId}`);
      return existingUser;
    }

    const stumbleId = await UserModel.generateSequentialPlayerId();
    const username = 'SGecho' + BackendUtils.GenCaracters(5).toUpperCase();

    const user = {
      id: parseInt(stumbleId),
      deviceId,
      stumbleId: stumbleId,
      username,
      country: 'BR',
      region: 'EU',
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
      inventory: [{
        userId: parseInt(stumbleId),
        itemId: 803,
        itemType: "DUPLICATE_BANK",
        item: "CONFIG_VERSION",
        amount: 3
      }],
      skins: ["SKIN1", "SKIN2"],
      emotes: ["emote_cry", "emote_hi", "emote_gg", "emote_haha", "emote_happy"],
      animations: ["animation1"],
      footsteps: ["footsteps_smoke"],
      balances: [ /* Cole aqui todos os seus balances originais */ ],
      userProfile: {
        userId: parseInt(stumbleId),
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
        ranked: { currentSeasonId: "LIVE_RANKED_SEASON_12", currentRankId: 0, currentTierIndex: 0 },
        flags: 0
      },
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
      },
      featureFlags: [ /* sua lista de featureFlags */ ]
    };

    const result = await database.createUser(user);
    Console.log("User", `Novo usuário criado com ID: ${stumbleId}`);
    return { ...user, _id: result.insertedId };
  }

  // ====================== SISTEMA DE FRIENDS ======================
  static async findByUsername(username) {
    return await database.getUserByQuery({ username });
  }

  static async sendFriendRequest(senderStumbleId, targetUsername) {
    const sender = await this.findByStumbleId(senderStumbleId);
    const target = await this.findByUsername(targetUsername);

    if (!target) throw new Error("Usuário não encontrado");
    if (sender.stumbleId === target.stumbleId) throw new Error("Não pode adicionar a si mesmo");
    if (sender.friends && sender.friends.includes(target.stumbleId)) throw new Error("Já são amigos");
    if (sender.sentFriendRequests && sender.sentFriendRequests.includes(target.stumbleId)) throw new Error("Solicitação já enviada");

    await database.collections.Users.updateOne(
      { stumbleId: senderStumbleId },
      { $addToSet: { sentFriendRequests: target.stumbleId } }
    );

    await database.collections.Users.updateOne(
      { stumbleId: target.stumbleId },
      { $addToSet: { receivedFriendRequests: senderStumbleId } }
    );

    return { success: true, message: "Solicitação enviada com sucesso!" };
  }

  static async getFriendsList(stumbleId) {
    const user = await this.findByStumbleId(stumbleId);
    if (!user) return null;

    const friends = await database.collections.Users.find({
      stumbleId: { $in: user.friends || [] }
    }).project({ stumbleId: 1, username: 1, country: 1, crowns: 1, skillRating: 1 }).toArray();

    const pending = await database.collections.Users.find({
      stumbleId: { $in: user.receivedFriendRequests || [] }
    }).project({ stumbleId: 1, username: 1, country: 1 }).toArray();

    return {
      friends: friends,
      pendingInvites: pending
    };
  }

  // ====================== OUTROS MÉTODOS (mantenha os seus) ======================
  static async findByDeviceId(deviceId) {
    return await database.getUserByQuery({ deviceId });
  }

  static async findByStumbleId(stumbleId) {
    return await database.getUserByQuery({ stumbleId });
  }

  static async update(stumbleId, updates) {
    await database.updateUser({ stumbleId }, updates);
    return await database.getUserByQuery({ stumbleId });
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
}

module.exports = {
  BackendUtils,
  Database,
  UserModel
};

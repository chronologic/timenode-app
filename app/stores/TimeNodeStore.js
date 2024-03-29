import { observable, computed } from 'mobx';
import CryptoJS from 'crypto-js';
import ethereumJsWallet from 'ethereumjs-wallet';

import { TIMENODE_WORKER_MESSAGE_TYPES } from '../js/timenode-worker-message-types';
import { showNotification } from '../services/notification';
import { LOGGER_MSG_TYPES, LOG_TYPE } from '../lib/worker-logger.js';
import { isMyCryptoSigValid, isSignatureValid, parseSig, SIGNATURE_ERRORS } from '../lib/signature';
import { getDAYBalance } from '../lib/timenode-util';
import { Config } from '@ethereum-alarm-clock/timenode-core';
import { Util } from '@ethereum-alarm-clock/lib';
import { isRunningInElectron } from '../lib/electron-util';
import { Networks } from '../config/web3Config';

/*
 * TimeNode classification based on the number
 * of DAY tokens held by the owner.
 */
export class TIMENODE_STATUS {
  static MASTER_CHRONONODE = {
    name: 'Master ChronoNode',
    minBalance: 3333
  };
  static CHRONONODE = {
    name: 'ChronoNode',
    minBalance: 888
  };
  static TIMENODE = {
    name: 'TimeNode',
    minBalance: 333
  };
  static DISABLED = 'Disabled';
  static LOADING = 'Loading';
}

// 2 minute as milliseconds
const STATUS_UPDATE_INTERVAL = 5 * 60 * 1000;
const LOG_CAP = 1000;
const BASIC_LOG_TYPES = [LOGGER_MSG_TYPES.INFO, LOGGER_MSG_TYPES.ERROR];

const STORAGE_KEYS = {
  ATTACHED_DAY_ACCOUNT: 'attachedDAYAccount',
  TIMENODE: 'tn',
  CLAIMING: 'claiming',
  SCANNING: 'isTimenodeScanning',
  PROVIDER_ID: 'selectedProviderId',
  PROVIDER_ENDPOINT: 'selectedProviderEndpoint'
};

export default class TimeNodeStore {
  @observable
  walletKeystore = null;
  @observable
  attachedDAYAccount = null;
  @observable
  scanningStarted = false;
  @observable
  claiming = false;

  @observable
  unlocked = false;

  @observable
  logType = LOG_TYPE.BASIC;

  @observable
  allLogs = [];
  @computed
  get logs() {
    if (this.logType === LOG_TYPE.BASIC) {
      return this.allLogs.filter(log => BASIC_LOG_TYPES.indexOf(log.type) > -1);
    }
    return this.allLogs;
  }

  @observable
  successfulExecutions = null;
  @observable
  failedExecutions = null;
  @observable
  successfulClaims = null;
  @observable
  failedClaims = null;
  @observable
  discovered = null;

  @observable
  balanceETH = null;
  @observable
  balanceDAY = null;
  @observable
  isTimeMint = null;

  @observable
  proposedNewNetId = null;

  @observable
  bountiesGraphData = null;
  @observable
  processedTxs = null;

  @computed
  get nodeStatus() {
    const { MASTER_CHRONONODE, CHRONONODE, TIMENODE, DISABLED, LOADING } = TIMENODE_STATUS;

    if (this.balanceDAY === null) {
      return LOADING;
    }

    if (this.balanceDAY >= MASTER_CHRONONODE.minBalance) {
      return MASTER_CHRONONODE.name;
    } else if (this.balanceDAY >= CHRONONODE.minBalance) {
      return CHRONONODE.name;
    } else if (this.balanceDAY >= TIMENODE.minBalance || this.isTimeMint) {
      return TIMENODE.name;
    } else {
      return DISABLED;
    }
  }

  @observable
  bounties = null;
  @observable
  costs = null;
  @observable
  profit = null;

  @computed
  get economicStrategy() {
    const load = strategy => {
      const loaded = this._storageService.load(strategy);
      return loaded ? loaded : Config.DEFAULT_ECONOMIC_STRATEGY[strategy].toString();
    };

    return {
      maxDeposit: load('maxDeposit'),
      minBalance: load('minBalance'),
      minProfitability: load('minProfitability'),
      maxGasSubsidy: load('maxGasSubsidy'),
      minClaimWindow: load('minClaimWindow'),
      minClaimWindowBlock: load('minClaimWindowBlock'),
      minExecutionWindow: load('minExecutionWindow'),
      minExecutionWindowBlock: load('minExecutionWindowBlock')
    };
  }

  // If a TimeNode has selected a custom provider URL
  // it will be stored in this variable
  @observable
  customProviderUrl = null;
  @observable
  providerBlockNumber = null;

  netId = null;

  get network() {
    const customNetId = this.getCustomProvider().id;
    const currentNetId = customNetId ? customNetId : this._web3Service.network.id;
    if (!Networks[currentNetId]) {
      return this.getCustomProvider();
    }
    return Networks[currentNetId];
  }

  timeNodeWorker = null;

  _keenStore = null;
  _storageService = null;
  _timeNodeStatusCheckIntervalRef = null;

  updateStatsInterval = null;
  updateBalancesInterval = null;
  updateBountiesGraphInterval = null;
  updateProcessedTxsInterval = null;
  getNetworkInfoInterval = null;

  @observable
  updatingBountiesGraphInProgress = false;
  @observable
  updatingProcessedTxsGraphInProgress = false;

  constructor(eacService, web3Service, keenStore, storageService) {
    this._eacService = eacService;
    this._web3Service = web3Service;
    this._keenStore = keenStore;
    this._storageService = storageService;

    this.attachedDAYAccount = this._storageService.load(STORAGE_KEYS.ATTACHED_DAY_ACCOUNT);
    this.walletKeystore = this._storageService.load(STORAGE_KEYS.TIMENODE);
    this.claiming = !!this._storageService.load(STORAGE_KEYS.CLAIMING);
    this.scanningStarted = !!this._storageService.load(STORAGE_KEYS.SCANNING);

    this.updateStats = this.updateStats.bind(this);
    this.updateBalances = this.updateBalances.bind(this);
    this.updateBountiesGraph = this.updateBountiesGraph.bind(this);
    this.getNetworkInfo = this.getNetworkInfo.bind(this);
    this.updateProcessedTxsGraph = this.updateProcessedTxsGraph.bind(this);
  }

  async unlockTimeNode(password) {
    if (this.walletKeystore && password) {
      this.unlocked = true;
      await this.startClient(this.walletKeystore, password);
      if (this._storageService.load(STORAGE_KEYS.SCANNING)) {
        await this.startScanning();
      }
    } else {
      this.unlocked = false;
      showNotification('Unable to unlock the TimeNode. Please try again');
    }
  }

  getWorkerOptions(keystore, keystorePassword) {
    return {
      network: this.network,
      customProviderUrl: this.customProviderUrl,
      keystore: [this.decrypt(keystore)],
      keystorePassword,
      dayAccountAddress: this.getAttachedDAYAddress(),
      logfile: 'console',
      logLevel: 1,
      milliseconds: 15000,
      autostart: false,
      scan: 950, // ~65min on kovan
      repl: false,
      browserDB: true,
      economicStrategy: this.economicStrategy,
      claiming: this.claiming
    };
  }

  stopIntervals() {
    clearInterval(this.updateStatsInterval);
    clearInterval(this.updateBalancesInterval);
    clearInterval(this.updateBountiesGraphInterval);
    clearInterval(this.getNetworkInfoInterval);
  }

  startIntervals() {
    this.updateStats();
    this.updateStatsInterval = setInterval(this.updateStats, 5000);

    this.updateBalances();
    this.updateBalancesInterval = setInterval(this.updateBalances, 15000);

    this.updateBountiesGraph();
    this.updateBountiesGraphInterval = setInterval(this.updateBountiesGraph, 300000);

    this.updateProcessedTxsGraph();
    this.updateProcessedTxsGraphInterval = setInterval(this.updateProcessedTxsGraph, 300000);

    this.getNetworkInfo();
    this.getNetworkInfoInterval = setInterval(this.getNetworkInfo, 15000);
  }

  startWorker(options) {
    return new Promise(resolve => {
      this.timeNodeWorker = new Worker('../js/timenode-worker.js', { type: 'module' });

      this.timeNodeWorker.onmessage = async event => {
        const { type, value } = event.data;
        const getValuesIfInMessage = values => {
          values.forEach(value => {
            if (event.data[value] !== null) {
              this[value] = event.data[value];
            }
          });
        };

        switch (type) {
          case TIMENODE_WORKER_MESSAGE_TYPES.STARTED:
            this.stopIntervals();
            this.startIntervals();

            resolve();
            break;

          case TIMENODE_WORKER_MESSAGE_TYPES.LOG:
            this.handleLogMessage(value);
            break;

          case TIMENODE_WORKER_MESSAGE_TYPES.UPDATE_STATS:
            getValuesIfInMessage([
              'bounties',
              'costs',
              'profit',
              'successfulClaims',
              'failedClaims',
              'successfulExecutions',
              'failedExecutions',
              'discovered'
            ]);
            break;

          case TIMENODE_WORKER_MESSAGE_TYPES.UPDATE_BALANCES:
            getValuesIfInMessage(['balanceETH', 'balanceDAY', 'isTimeMint']);
            break;

          case TIMENODE_WORKER_MESSAGE_TYPES.CLEAR_STATS:
            showNotification('Cleared the stats.', 'success');
            this.updateStats();
            break;

          case TIMENODE_WORKER_MESSAGE_TYPES.GET_NETWORK_INFO:
            getValuesIfInMessage(['providerBlockNumber', 'netId']);
            if (this._keenStore.timeNodeSpecificProviderNetId != this.netId) {
              this._keenStore.setTimeNodeSpecificProviderNetId(this.netId);
              await this._keenStore.refreshActiveTimeNodesCount();
            }
            break;

          case TIMENODE_WORKER_MESSAGE_TYPES.RECEIVED_CLAIMED_NOT_EXECUTED_TRANSACTIONS:
            this._getClaimedNotExecutedTransactionsPromiseResolver(event.data['transactions']);
            break;

          case TIMENODE_WORKER_MESSAGE_TYPES.BOUNTIES_GRAPH_DATA:
            this.updatingBountiesGraphInProgress = false;
            getValuesIfInMessage(['bountiesGraphData']);
            break;

          case TIMENODE_WORKER_MESSAGE_TYPES.PROCESSED_TXS:
            getValuesIfInMessage(['processedTxs']);
            this.updatingProcessedTxsGraphInProgress = false;
            break;
        }
      };

      this.sendMessageWorker(TIMENODE_WORKER_MESSAGE_TYPES.START, options);
    });
  }

  async getClaimedNotExecutedTransactions() {
    this.sendMessageWorker(TIMENODE_WORKER_MESSAGE_TYPES.GET_CLAIMED_NOT_EXECUTED_TRANSACTIONS);

    return new Promise(resolve => {
      this._getClaimedNotExecutedTransactionsPromiseResolver = resolve;
    });
  }

  handleLogMessage(log) {
    if (log.type === LOGGER_MSG_TYPES.CACHE) return;

    if (isRunningInElectron()) {
      window.ipc.send('save-timenode-logs', log);
    }

    if (this.allLogs.length === LOG_CAP) this.allLogs.shift();
    this.allLogs.push(log);
  }

  sendActiveTimeNodeEvent() {
    if (this.scanningStarted) {
      this._keenStore.sendActiveTimeNodeEvent(this.getMyAddress(), this.getAttachedDAYAddress());
    }
  }

  async startScanning() {
    if (this.nodeStatus === TIMENODE_STATUS.DISABLED) {
      return;
    }

    this.scanningStarted = true;

    this.sendActiveTimeNodeEvent();

    this._timeNodeStatusCheckIntervalRef = setInterval(
      () => this.sendActiveTimeNodeEvent(),
      STATUS_UPDATE_INTERVAL
    );

    this.sendMessageWorker(TIMENODE_WORKER_MESSAGE_TYPES.START_SCANNING);

    this.updateStats();
    this._storageService.save(STORAGE_KEYS.SCANNING, true);
  }

  stopScanning() {
    this.scanningStarted = false;

    if (this._timeNodeStatusCheckIntervalRef) {
      clearInterval(this._timeNodeStatusCheckIntervalRef);
    }

    if (this.timeNodeWorker) {
      this.sendMessageWorker(TIMENODE_WORKER_MESSAGE_TYPES.STOP_SCANNING);
    }
    this._storageService.remove(STORAGE_KEYS.SCANNING);
  }

  encrypt(message) {
    return CryptoJS.AES.encrypt(message, '88e19245648ba7616099fbd6595d120d');
  }

  decrypt(message) {
    if (typeof message !== 'string') {
      message = message.toString();
    }
    const bytes = CryptoJS.AES.decrypt(message, '88e19245648ba7616099fbd6595d120d');
    return bytes.toString(CryptoJS.enc.Utf8);
  }

  /*
   * Starts the timenode client.
   * Immediately starts executing transactions and outputting logs.
   */
  async startClient(keystore, password) {
    await this._web3Service.init();

    await this.startWorker(this.getWorkerOptions(keystore, password));
  }

  setKeyStore(keystore) {
    this.walletKeystore = keystore;
    this._storageService.save(STORAGE_KEYS.TIMENODE, keystore);
  }

  async testCustomProvider(endpoint) {
    return Util.testProvider(endpoint);
  }

  async setCustomProvider(id, endpoint) {
    this.customProviderUrl = endpoint;
    this._storageService.save(STORAGE_KEYS.PROVIDER_ID, id);
    this._storageService.save(STORAGE_KEYS.PROVIDER_ENDPOINT, endpoint);

    this.stopScanning();

    // Reload the page so that the changes are refreshed
    if (isRunningInElectron()) {
      window.remote.getCurrentWindow().reload();
    } else {
      window.location.reload();
    }
  }

  getCustomProvider() {
    return {
      id: parseInt(this._storageService.load(STORAGE_KEYS.PROVIDER_ID)),
      endpoint: this._storageService.load(STORAGE_KEYS.PROVIDER_ENDPOINT)
    };
  }

  getMyAddress() {
    if (this.walletKeystore) {
      const ks = this.decrypt(this.walletKeystore);
      const address = JSON.parse(ks).address;

      if (address && address.indexOf('0x') === -1) {
        return '0x' + address;
      }

      return address;
    }

    return '';
  }

  getAttachedDAYAddress() {
    const encryptedAddress = this._storageService.load(STORAGE_KEYS.ATTACHED_DAY_ACCOUNT);
    if (encryptedAddress) {
      return this.decrypt(encryptedAddress);
    } else {
      return '';
    }
  }

  sendMessageWorker(messageType, params = {}) {
    if (this.timeNodeWorker) {
      this.timeNodeWorker.postMessage({
        type: messageType,
        params
      });
    }
  }

  getNetworkInfo() {
    this.sendMessageWorker(TIMENODE_WORKER_MESSAGE_TYPES.GET_NETWORK_INFO);
  }

  updateStats() {
    this.sendMessageWorker(TIMENODE_WORKER_MESSAGE_TYPES.UPDATE_STATS);
  }

  updateBalances() {
    this.sendMessageWorker(TIMENODE_WORKER_MESSAGE_TYPES.UPDATE_BALANCES);
  }

  updateBountiesGraph() {
    this.updatingBountiesGraphInProgress = true;
    this.sendMessageWorker(TIMENODE_WORKER_MESSAGE_TYPES.BOUNTIES_GRAPH_DATA);
  }

  updateProcessedTxsGraph() {
    this.updatingProcessedTxsGraphInProgress = true;
    this.sendMessageWorker(TIMENODE_WORKER_MESSAGE_TYPES.PROCESSED_TXS);
  }

  clearStats() {
    this.sendMessageWorker(TIMENODE_WORKER_MESSAGE_TYPES.CLEAR_STATS);
    this.allLogs = [];
  }

  /*
   * Attaches a DAY-token-holding account to the session
   * as a proof-of-ownership of DAY tokens.
   * If it contains DAY tokens, it allows the usage of TimeNodes.
   */
  async attachDayAccount(sigObject) {
    try {
      const signature = parseSig(sigObject);

      const timeNodeAddr = this.getMyAddress();

      // First check using default sig check - if doesn't work use MyCrypto's
      const validSig =
        isSignatureValid(signature, timeNodeAddr) || isMyCryptoSigValid(signature, timeNodeAddr);

      if (!validSig) throw SIGNATURE_ERRORS.INVALID_SIG;

      const { balanceDAY, mintingPower } = await getDAYBalance(
        this.network,
        Util.getWeb3FromProviderUrl(this.network.endpoint),
        signature.address
      );

      this.balanceDAY = parseInt(balanceDAY);
      this.isTimeMint = parseInt(mintingPower) > 0;

      const encryptedAttachedAddress = this.encrypt(signature.address);

      if (this.nodeStatus !== TIMENODE_STATUS.DISABLED) {
        this._storageService.save(STORAGE_KEYS.ATTACHED_DAY_ACCOUNT, encryptedAttachedAddress);
        this.attachedDAYAccount = encryptedAttachedAddress;
        showNotification('Success.', 'success');
      } else {
        showNotification('Not enough DAY tokens. Current balance: ' + balanceDAY.toString());
      }
    } catch (error) {
      if (error == `TypeError: Cannot read property 'dayTokenAddress' of undefined`) {
        showNotification('Unsupported custom provider.');
      } else {
        showNotification(error);
      }
    }
  }

  saveClaimingStrategy(economicStrategy) {
    if (this.claiming) {
      this._storageService.save(STORAGE_KEYS.CLAIMING, true);
    } else {
      this._storageService.remove(STORAGE_KEYS.CLAIMING);
    }

    const numberFromString = string => this._web3Service.web3.utils.toWei(string, 'ether');
    for (let key of Object.keys(economicStrategy)) {
      if (economicStrategy[key]) {
        const value =
          key === 'maxGasSubsidy' ? economicStrategy[key] : numberFromString(economicStrategy[key]);
        this._storageService.save(key, value);
      } else {
        this._storageService.remove(key);
      }
    }
  }

  hasStorageItems(itemList) {
    for (let item of itemList) {
      if (!this._storageService.load(item)) {
        return false;
      }
    }
    return true;
  }

  async restart(password) {
    this.stopScanning();
    this.stopIntervals();
    this.timeNodeWorker = null;
    await this.startClient(this.walletKeystore, password);
    await this.startScanning();
  }

  detachWallet() {
    this._storageService.remove(STORAGE_KEYS.TIMENODE);
    this.walletKeystore = null;

    this._storageService.remove(STORAGE_KEYS.ATTACHED_DAY_ACCOUNT);
    this.attachedDAYAccount = null;

    this._storageService.remove(STORAGE_KEYS.CLAIMING);
    this.claiming = false;

    this._storageService.remove(STORAGE_KEYS.SCANNING);
    this.stopScanning();

    this.timeNodeWorker = null;
    showNotification('Your wallet has been detached.', 'success');
  }

  passwordMatchesKeystore(password) {
    try {
      ethereumJsWallet.fromV3(this.decrypt(this.walletKeystore), password, true);
      showNotification('Success.', 'success');
      return true;
    } catch (e) {
      if (e.message === 'Key derivation failed - possibly wrong passphrase') {
        showNotification('Please enter a valid password.');
      } else {
        showNotification(e);
      }
      return false;
    }
  }
}

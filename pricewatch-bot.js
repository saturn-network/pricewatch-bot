#!/usr/bin/env node
const axios     = require('axios')
const chalk     = require('chalk')
const ethers    = require('ethers')
const moment    = require('moment')
const _         = require('lodash')
const program   = require('commander')
const Table     = require('easy-table')
const BigNumber = require('bignumber.js')
const Saturn    = require('@saturnnetwork/saturn.js').Saturn

const version   = require('./package.json').version
const saturnApi = 'https://ticker.saturn.network/api/v2'
const epsilon   = new BigNumber('0.00005')

const pipeline = async (funcs) => {
  return await funcs.reduce((promise, func) => {
    return promise.then(result => {
      return func().then(Array.prototype.concat.bind(result))
    })
  }, Promise.resolve([]))
}

function getChainId(chain) {
  if (chain === 'ETC') { return 61 }
  if (chain === 'ETH') { return 1 }
  console.log('Unknown chainId for chain', chain)
  process.exit(1)
}

function rpcNode(chain) {
  if (chain === 'ETC') { return 'https://www.ethercluster.com/etc' }
  if (chain === 'ETH') { return 'https://cloudflare-eth.com' }
  console.log('Unknown chainId for chain', chain)
  process.exit(1)
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

function makeSaturnClient(blockchain, program, wallet) {
  let rpcnode = rpcNode(blockchain)
  let chainId = getChainId(blockchain)
  let provider = new ethers.providers.JsonRpcProvider(rpcnode, { chainId: chainId, name: blockchain })

  let saturn
  if (blockchain === 'ETC') {
    saturn = new Saturn(saturnApi, { etc: wallet.connect(provider) })
  } else {
    saturn = new Saturn(saturnApi, { eth: wallet.connect(provider) })
  }

  return saturn
}

let tradesForToken = async function(token, blockchain, action, timestamp) {
  let url = `${saturnApi}/trades/by_timestamp/${blockchain}/0x0000000000000000000000000000000000000000/${token}/${timestamp}.json`
  let subset = action === "buy" ? "buys" : "sells"

  let trades = await axios.get(url)
  if (trades.status !== 200) {
    throw new Error(`API error while fetching trade info. Status code ${trades.status}`)
  }
  return trades.data[subset]
}

let etherVolume = function(trades, wallet, action) {
  let filtered = _.filter(trades, (x) => {
    return (x.buyer === wallet.toLowerCase() || x.seller === wallet.toLowerCase())
  })
  if (filtered.length === 0) { return new BigNumber(0) }
  if (action === 'buy') {
    let amounts = _.map(filtered, (x) => new BigNumber(x.buytokenamount))
    return _.reduce(amounts, (x, y) => x.plus(y), new BigNumber(0))
  } else {
    let amounts = _.map(filtered, (x) => new BigNumber(x.selltokenamount))
    return _.reduce(amounts, (x, y) => x.plus(y), new BigNumber(0))
  }
}

let allowedLimit = async function(token, blockchain, action, wallet, limit) {
  let oneHourAgo = moment().subtract(1, 'hour').unix()
  let trades = await tradesForToken(token, blockchain, action, oneHourAgo)

  return new BigNumber(limit).minus(etherVolume(trades, wallet, action))
}

let orderInfo = async function(blockchain, tx) {
  let url = `${saturnApi}/orders/by_tx/${blockchain}/${tx}.json`

  let order = await axios.get(url)
  if (order.status !== 200) {
    throw new Error(`API error while fetching trade info. Status code ${trades.status}`)
  }
  let price = new BigNumber(order.data.price)
  let balance = new BigNumber(order.data.balance)
  return {
    price: price,
    tokenbalance: balance,
    etherbalance: price.times(balance)
  }
}

let tokenBalance = async function(blockchain, token, wallet) {
  let url = `${saturnApi}/tokens/balances/${blockchain}/${wallet}/${token}.json`

  let response = await axios.get(url)
  if (response.status !== 200) {
    throw new Error(`API error while fetching trade info. Status code ${trades.status}`)
  }

  return new BigNumber(response.data.balances.walletbalance)
}

let etherBalance = async function(blockchain, wallet) {
  let url = `${saturnApi}/tokens/balances/${blockchain}/${wallet}/0x0000000000000000000000000000000000000000.json`

  let response = await axios.get(url)
  if (response.status !== 200) {
    throw new Error(`API error while fetching trade info. Status code ${trades.status}`)
  }

  return new BigNumber(response.data.balances.walletbalance)
}



program
  .version(version, '-v, --version')
  .description('Watch a price of a given token on Saturn Network and auto buy/sell. More details are available at ' + chalk.underline.red('https://forum.saturn.network/t/saturn-trading-bot-guides/4046'))
  .option('-p, --pkey [pkey]', 'Private key of the wallet to use for trading')
  .option('-m, --mnemonic [mnemonic]', 'Mnemonic (i.e. from Saturn Wallet) of the wallet to use for trading')
  .option('-i, --walletid [walletid]', 'If using a mnemonic, choose which wallet to use. Default is Account 2 of Saturn Wallet / MetaMask.', 2)
  .option('-j, --json [json]', 'Trading bot config file')
  .option('-d, --delay [delay]', 'Polling delay in seconds', 60)
  .parse(process.argv)

if (!program.mnemonic && !program.pkey) {
  console.error('At least one of [pkey], [mnemonic] must be supplied')
  process.exit(1)
}

if (program.mnemonic && program.pkey) {
  console.error('Only one of [pkey], [mnemonic] must be supplied')
  process.exit(1)
}

let wallet
if (program.mnemonic) {
  let walletid = parseInt(program.walletid) - 1
  wallet = ethers.Wallet.fromMnemonic(program.mnemonic, `m/44'/60'/0'/0/${walletid}`)
} else {
  wallet = new ethers.Wallet(program.pkey)
}

if (!program.json) {
  console.error('Must specify bot config .json file location')
  process.exit(1)
}

console.log(chalk.green(`Loading pricewatch-bot v${version} ...`))
console.log(chalk.green(`Trading address: ${chalk.underline(wallet.address)}\nUsing the following strategies`))
let botconfig = require(program.json)
console.log(Table.print(botconfig, {
  houretherlimit: { name: 'Hourly ether limit' },
  action: { printer: function (val, width) {
      let text = val === "buy" ? chalk.green.bold(val) : chalk.red.bold(val)
      return width ? Table.padLeft(text, width) : text
    }},
  blockchain: { printer: function (val, width) {
      let text = val === "ETC" ? chalk.black.bgGreen.bold(val) : chalk.black.bgWhite.bold(val)
      return width ? Table.padLeft(text, width) : text
    }}
}))


let trade = async function() {
  try {
    let schedule = []
    await Promise.all(_.map(botconfig, async (row) => {
      let saturn = makeSaturnClient(row.blockchain.toUpperCase(), program, wallet)
      let info = await saturn.query.getTokenInfo(row.token, row.blockchain)

      if (row.action === 'buy') {
        let threshold = new BigNumber(row.price)
        let bestBuyPrice = new BigNumber(info.best_sell_price)

        if (bestBuyPrice.isLessThanOrEqualTo(threshold)) {
          schedule.push(async () => {
            console.log(chalk.yellow(`Buy opportunity for ${row.blockchain}::${row.token} @ ${chalk.green(info.best_sell_price)}`))
            let tradeLimit = await allowedLimit(
              row.token.toLowerCase(),
              row.blockchain.toUpperCase(),
              row.action,
              wallet.address,
              row.houretherlimit
            )
            if (! tradeLimit.gt(epsilon)) {
              console.log(chalk.yellow(`Hourly trade limit reached. Skipping...`))
              return true
            }
            let order = await orderInfo(row.blockchain, info.best_sell_order_tx)

            let tradeEtherAmount = tradeLimit.gt(order.etherbalance) ?
              order.etherbalance : tradeLimit

            let walletBalance = await etherBalance(row.blockchain, wallet.address)
            if (! walletBalance.gt(epsilon)) {
              console.log(chalk.yellow(`Not enough ${row.blockchain} in your wallet to complete transaction. Skipping...`))
              return true
            }

            tradeEtherAmount = tradeEtherAmount.gt(walletBalance) ? walletBalance : tradeEtherAmount

            let tokenAmount = tradeEtherAmount.dividedBy(order.price).toFixed(parseInt(info.decimals))
            let tx = await saturn[row.blockchain.toLowerCase()].newTrade(tokenAmount, info.best_sell_order_tx)

            console.log(chalk.yellow(`Attempting to buy ${tokenAmount} tokens\ntx: ${chalk.underline(tx)}`))
            await saturn.query.awaitTradeTx(tx, saturn[row.blockchain.toLowerCase()])
          })
        }
      } else if (row.action === 'sell') {
        let threshold = new BigNumber(row.price)
        let bestSellPrice = new BigNumber(info.best_buy_price)

        if (bestSellPrice.isGreaterThanOrEqualTo(threshold)) {
          schedule.push(async () => {
            console.log(chalk.yellow(`Sell opportunity for ${row.blockchain}::${row.token} @ ${chalk.red(info.best_buy_price)}`))
            let tradeLimit = await allowedLimit(
              row.token.toLowerCase(),
              row.blockchain.toUpperCase(),
              row.action,
              wallet.address,
              row.houretherlimit
            )
            if (! tradeLimit.gt(epsilon)) {
              console.log(chalk.yellow(`Hourly trade limit reached. Skipping...`))
              return true
            }
            let order = await orderInfo(row.blockchain, info.best_buy_order_tx)

            let tradeEtherAmount = tradeLimit.gt(order.etherbalance) ?
              order.etherbalance : tradeLimit

            let tokenAmount = tradeEtherAmount.dividedBy(order.price).toFixed(parseInt(info.decimals))

            let walletBalance = await tokenBalance(row.blockchain, row.token, wallet.address)
            if (! walletBalance.gt(epsilon)) {
              console.log(chalk.yellow(`Not enough ${row.blockchain}::${row.token} in your wallet to complete transaction. Skipping...`))
              return true
            }

            tokenAmount = new BigNumber(tokenAmount).gt(walletBalance) ? walletBalance : tokenAmount
            let tx = await saturn[row.blockchain.toLowerCase()].newTrade(tokenAmount, info.best_buy_order_tx)

            console.log(chalk.yellow(`Attempting to sell ${tokenAmount} tokens\ntx: ${chalk.underline(tx)}`))
            await saturn.query.awaitTradeTx(tx, saturn[row.blockchain.toLowerCase()])
          })
        }
      } else {
        throw new Error(`Unknown action ${row.action}`)
      }
    }))
    if (schedule.length) { await pipeline(schedule) }
  } catch(error) {
    console.error(error.message)
  }

  setTimeout(trade, parseInt(program.delay) * 1000)
};

(async () => await trade())()

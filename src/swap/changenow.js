// @flow

import { lt, mul } from 'biggystring'
import {
  type EdgeCorePluginOptions,
  type EdgeCurrencyWallet,
  type EdgeSwapPlugin,
  type EdgeSwapPluginQuote,
  type EdgeSwapRequest,
  type EdgeTransaction,
  SwapAboveLimitError,
  SwapBelowLimitError,
  SwapCurrencyError
} from 'edge-core-js/types'

import { getFetchJson } from '../react-native-io.js'
import { makeSwapPluginQuote } from '../swap-helpers.js'

const swapInfo = {
  pluginName: 'changenow',
  displayName: 'Change NOW',

  quoteUri: 'https://changenow.io/exchange/txs/',
  supportEmail: 'support@changenow.io'
}

const uri = 'https://changenow.io/api/v1/'
const expirationMs = 1000 * 60 * 20

type QuoteInfo = {
  error?: string,
  id: string,
  payinAddress: string,
  payoutAddress: string,
  fromCurrency: string,
  toCurrency: string,
  payinExtraId?: string | null,
  refundAddress: string,
  amount: string,
  rate?: string | null,
  minerFee?: string | null,
  isEstimate: boolean
}

const dontUseLegacy = {
  DGB: true
}

const CURRENCY_CODE_TRANSCRIPTION = {
  USDT: 'USDTERC20'
}

// Invalid currency codes should *not* have transcribed codes
// because currency codes with transcribed versions are NOT invalid
const INVALID_CURRENCY_CODES = {
  // edgeCurrenvyCode: exchangeCurrencyCode
}

async function getAddress (
  wallet: EdgeCurrencyWallet,
  currencyCode: string
): Promise<string> {
  const addressInfo = await wallet.getReceiveAddress({ currencyCode })
  return addressInfo.legacyAddress && !dontUseLegacy[currencyCode]
    ? addressInfo.legacyAddress
    : addressInfo.publicAddress
}

export function makeChangeNowPlugin (
  opts: EdgeCorePluginOptions
): EdgeSwapPlugin {
  const { initOptions, io } = opts
  const fetchJson = getFetchJson(opts)

  if (initOptions.apiKey == null) {
    throw new Error('No ChangeNow apiKey provided.')
  }
  const { apiKey } = initOptions

  async function call (json: any) {
    const body = JSON.stringify(json.body)
    io.console.info('changenow call fixed :', json)
    const headers = {
      'Content-Type': 'application/json'
    }

    const api = uri + json.route + apiKey
    const reply = await fetchJson(api, { method: 'POST', body, headers })
    if (!reply.ok) {
      throw new Error(`CN: ChangeNow call returned error code ${reply.status}`)
    }
    const out = reply.json
    io.console.info('changenow fixed reply:', out)
    return out
  }

  async function get (path: string) {
    const api = `${uri}${path}`
    const reply = await fetchJson(api)
    return reply.json
  }

  const out: EdgeSwapPlugin = {
    swapInfo,

    async fetchSwapQuote (
      request: EdgeSwapRequest,
      userSettings: Object | void
    ): Promise<EdgeSwapPluginQuote> {
      if (
        // if either currencyCode is invalid *and* doesn't have a transcription
        INVALID_CURRENCY_CODES[request.fromCurrencyCode] ||
        INVALID_CURRENCY_CODES[request.toCurrencyCode]
      ) {
        throw new SwapCurrencyError(
          swapInfo,
          request.fromCurrencyCode,
          request.toCurrencyCode
        )
      }
      // Grab addresses:
      let isEstimate = true
      const [fromAddress, toAddress] = await Promise.all([
        getAddress(request.fromWallet, request.fromCurrencyCode),
        getAddress(request.toWallet, request.toCurrencyCode)
      ])

      // transcribe currencyCodes if necessary
      let safeFromCurrencyCode = request.fromCurrencyCode
      let safeToCurrencyCode = request.toCurrencyCode
      if (CURRENCY_CODE_TRANSCRIPTION[request.fromCurrencyCode]) {
        safeFromCurrencyCode =
          CURRENCY_CODE_TRANSCRIPTION[request.fromCurrencyCode]
      }
      if (CURRENCY_CODE_TRANSCRIPTION[request.toCurrencyCode]) {
        safeToCurrencyCode = CURRENCY_CODE_TRANSCRIPTION[request.toCurrencyCode]
      }

      // get the markets
      const availablePairs = await get('currencies-to/' + safeFromCurrencyCode)
      const fixedMarket = await get('market-info/fixed-rate/' + apiKey) // Promise.all([fetchCurrencies()])

      const quoteAmount =
        request.quoteFor === 'from'
          ? await request.fromWallet.nativeToDenomination(
            request.nativeAmount,
            request.fromCurrencyCode
          )
          : await request.toWallet.nativeToDenomination(
            request.nativeAmount,
            request.toCurrencyCode
          )

      // Swap the currencies if we need a reverse quote:
      const quoteParams =
        request.quoteFor === 'from'
          ? {
            from: safeFromCurrencyCode.toLowerCase(),
            to: safeToCurrencyCode.toLowerCase(),
            amount: quoteAmount
          }
          : {
            from: safeToCurrencyCode.toLowerCase(),
            to: safeFromCurrencyCode.toLowerCase(),
            amount: quoteAmount
          }

      const pairsToUse = []
      let useFixed = false
      let fromAmount, fromNativeAmount, toNativeAmount
      let pairItem
      let quoteReplyKeep = { estimatedAmount: '0' }
      for (let i = 0; i < availablePairs.length; i++) {
        const obj = availablePairs[i]
        if (safeToCurrencyCode.toLowerCase() === obj.ticker) {
          pairsToUse.push(obj)
          if (obj.supportsFixedRate) {
            let minerFee = null
            let rate = null
            useFixed = true
            for (let j = 0; j < fixedMarket.length; j++) {
              const item = fixedMarket[j]
              if (
                item.from === quoteParams.from &&
                item.to === quoteParams.to
              ) {
                pairItem = item
                const [nativeMax, nativeMin] = await Promise.all([
                  request.fromWallet.denominationToNative(
                    item.max.toString(),
                    request.fromCurrencyCode
                  ),
                  request.fromWallet.denominationToNative(
                    item.min.toString(),
                    request.fromCurrencyCode
                  )
                ])
                // lets get the quoteObject here
                const estQuery =
                  'exchange-amount/fixed-rate/' +
                  quoteParams.amount +
                  '/' +
                  quoteParams.from +
                  '_' +
                  quoteParams.to +
                  '?api_key=' +
                  apiKey
                const quoteReply = await get(estQuery)
                if (quoteReply.error === 'out_of_range') {
                  if (lt(quoteParams.amount, item.min.toString())) {
                    throw new SwapBelowLimitError(swapInfo, nativeMin)
                  } else {
                    throw new SwapAboveLimitError(swapInfo, nativeMax)
                  }
                }
                if (quoteReply.error) {
                  throw new SwapCurrencyError(
                    swapInfo,
                    request.fromCurrencyCode,
                    request.toCurrencyCode
                  )
                }
                minerFee = item.minerFee
                rate = item.rate
                quoteReplyKeep = quoteReply
              }
            }
            if (pairItem) {
              if (request.quoteFor === 'from') {
                fromAmount = quoteAmount
                fromNativeAmount = request.nativeAmount
                toNativeAmount = await request.toWallet.denominationToNative(
                  quoteReplyKeep.estimatedAmount.toString(),
                  request.toCurrencyCode
                )
              } else {
                fromAmount = mul(
                  quoteReplyKeep.estimatedAmount.toString(),
                  '1.02'
                )
                fromNativeAmount = await request.fromWallet.denominationToNative(
                  fromAmount,
                  request.fromCurrencyCode
                )
                toNativeAmount = request.nativeAmount
              }
              const sendReply = await call({
                route: 'transactions/fixed-rate/',
                body: {
                  amount: fromAmount,
                  from: safeFromCurrencyCode,
                  to: safeToCurrencyCode,
                  address: toAddress,
                  extraId: null, // TODO: Do we need this for Monero?
                  refundAddress: fromAddress
                }
              })
              io.console.info('CN: Fixed sendReply q ', sendReply)
              const quoteInfo: QuoteInfo = {
                id: sendReply.id,
                payinAddress: sendReply.payinAddress,
                payoutAddress: sendReply.payoutAddress,
                fromCurrency: sendReply.fromCurrency,
                toCurrency: sendReply.toCurrency,
                payinExtraId: sendReply.payinExtraId || null,
                refundAddress: sendReply.refundAddress,
                amount: sendReply.amount,
                rate: rate || null,
                minerFee: minerFee || null,
                isEstimate: !useFixed
              }
              const spendInfo = {
                currencyCode: request.fromCurrencyCode,
                spendTargets: [
                  {
                    nativeAmount: fromNativeAmount,
                    publicAddress: quoteInfo.payinAddress,
                    otherParams: {
                      uniqueIdentifier: quoteInfo.payinExtraId
                    }
                  }
                ]
              }
              io.console.info('changenow spendInfo', spendInfo)
              const tx: EdgeTransaction = await request.fromWallet.makeSpend(
                spendInfo
              )
              if (tx.otherParams == null) tx.otherParams = {}
              tx.otherParams.payinAddress =
                spendInfo.spendTargets[0].publicAddress
              tx.otherParams.uniqueIdentifier =
                spendInfo.spendTargets[0].otherParams.uniqueIdentifier
              isEstimate = false
              const toAmount = await request.toWallet.denominationToNative(
                sendReply.amount.toString(),
                request.toCurrencyCode
              )
              return makeSwapPluginQuote(
                request,
                fromNativeAmount,
                toAmount,
                tx,
                toAddress,
                'changenow',
                isEstimate,
                new Date(Date.now() + expirationMs),
                quoteInfo.id
              )
            }
          }
        }
      }
      if (pairsToUse.length === 0) {
        throw new SwapCurrencyError(
          swapInfo,
          request.fromCurrencyCode,
          request.toCurrencyCode
        )
      }
      const estQuery =
        'exchange-amount/' +
        quoteParams.amount +
        '/' +
        quoteParams.from +
        '_' +
        quoteParams.to
      const min = await get(
        'min-amount/' + quoteParams.from + '_' + quoteParams.to
      )
      if (min.minAmount == null) {
        throw new SwapCurrencyError(
          swapInfo,
          request.fromCurrencyCode,
          request.toCurrencyCode
        )
      }
      const [nativeMin] = await Promise.all([
        request.fromWallet.denominationToNative(
          min.minAmount.toString(),
          request.fromCurrencyCode
        )
      ])

      const quoteReply = await get(estQuery)
      if (quoteReply.error) {
        io.console.info('CN: reply error ', quoteReply.error)
        if (quoteReply.error === 'deposit_too_small') {
          throw new SwapBelowLimitError(swapInfo, nativeMin)
        }
      }
      io.console.info('CN:got reply  ', quoteReply)
      if (request.quoteFor === 'from') {
        fromAmount = quoteAmount
        fromNativeAmount = request.nativeAmount
        toNativeAmount = await request.toWallet.denominationToNative(
          quoteReply.estimatedAmount.toString(),
          request.toCurrencyCode
        )
      } else {
        fromAmount = mul(quoteReply.estimatedAmount.toString(), '1.02')
        fromNativeAmount = await request.fromWallet.denominationToNative(
          fromAmount,
          request.fromCurrencyCode
        )
        toNativeAmount = request.nativeAmount
      }
      console.log('CN: estQuery quoteReply  ', quoteReply)

      if (lt(fromNativeAmount, nativeMin)) {
        throw new SwapBelowLimitError(swapInfo, nativeMin)
      }

      const sendReply = await call({
        route: 'transactions/',
        body: {
          amount: fromAmount,
          from: safeFromCurrencyCode.toLowerCase(),
          to: safeToCurrencyCode.toLowerCase(),
          address: toAddress,
          extraId: null, // TODO: Do we need this for Monero?
          refundAddress: fromAddress
        }
      })
      // checkReply(sendReply)
      const quoteInfo: QuoteInfo = {
        id: sendReply.id,
        payinAddress: sendReply.payinAddress,
        payoutAddress: sendReply.payoutAddress,
        fromCurrency: sendReply.fromCurrency,
        toCurrency: sendReply.toCurrency,
        payinExtraId: sendReply.payinExtraId || null,
        refundAddress: sendReply.refundAddress,
        amount: sendReply.amount,
        rate: sendReply.rate || null,
        minerFee: sendReply.minerFee || null,
        isEstimate: !useFixed
      }

      // Make the transaction:
      const spendInfo = {
        currencyCode: request.fromCurrencyCode,
        spendTargets: [
          {
            nativeAmount: fromNativeAmount,
            publicAddress: quoteInfo.payinAddress,
            otherParams: {
              uniqueIdentifier: quoteInfo.payinExtraId
            }
          }
        ]
      }
      io.console.info('changenow spendInfo', spendInfo)
      const tx: EdgeTransaction = await request.fromWallet.makeSpend(spendInfo)
      if (tx.otherParams == null) tx.otherParams = {}
      tx.otherParams.payinAddress = spendInfo.spendTargets[0].publicAddress
      tx.otherParams.uniqueIdentifier =
        spendInfo.spendTargets[0].otherParams.uniqueIdentifier

      return makeSwapPluginQuote(
        request,
        fromNativeAmount,
        toNativeAmount,
        tx,
        toAddress,
        'changenow',
        isEstimate,
        new Date(Date.now() + expirationMs) // ,
        // quoteInfo.id
      )
    }
  }

  return out
}

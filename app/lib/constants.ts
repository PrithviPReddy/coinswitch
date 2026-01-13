import { getMinimumBalanceForRentExemptAccountWithExtensions } from "@solana/spl-token"
import { Connection } from "@solana/web3.js"

let LAST_UPDATED : number | null = null
let prices: {[key: string]: {
    price: string;
}} = {};
const TOKEN_PRICE_REFRESH_RATE = 60000

export const SUPPORTED_TOKENS : {
    name : string,
    mint : string,
    native :boolean
}[] = [{
    name :"USDC",
    mint:"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v",
    native : false,
},{
    name : "USDT",
    mint : "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB",
    native : false,
},{
    name : "SOL",
    mint : "So11111111111111111111111111111111111111112",
    native : false,
}]

export const connection = new Connection("https://api.mainnet-beta.solana.com")

export async function getSupportedTokens(){
    const apiKey = process.env.JUP_API_KEY
    if (!LAST_UPDATED || new Date().getTime() - LAST_UPDATED < TOKEN_PRICE_REFRESH_RATE){
        const response = await (
            await fetch(
                'https://api.jup.ag/price/v3?ids=So11111111111111111111111111111111111111112',
                {
                    headers: {
                        'x-api-key': apiKey!,
                    },
                }
            )
        ).json();
        LAST_UPDATED = new Date().getTime();
        prices = response.data.data
    }
     return SUPPORTED_TOKENS.map(s => ({
        ...s,
        price: prices[s.name].price
    }))
}
import { Connection } from "@solana/web3.js"

export const SUPPORTED_TOKENS : {
    name : string,
    mint : string
}[] = [{
    name :"USDC",
    mint:"EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v"
},{
    name : "USDT",
    mint : "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"
}]

export const connection = new Connection("https://api.mainnet-beta.solana.com")
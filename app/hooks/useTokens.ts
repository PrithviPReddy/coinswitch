import { useEffect, useState } from "react";
import axios from "axios";

export type TokenWithBalance = {
  name: string;
  mint: string;
  image: string;
  price: number;
  balance: number;
  usdBalance: number;
};


export function useTokens(address : string){

    const  [tokenBalances,setTokenBalances] = useState<{
        totalBalance : number
        tokens : TokenWithBalance[]
    } | null >(null)

    const [loading, setLoading] = useState(true)


    useEffect(() => {

        // axios.get(`/api/tokens?address=${address}`)
        axios.get(`/api/tokens?address=6666XvWNjT5UXPtQ1MyfLo7TMrv4gnLaWjdYsMszJwDC`)
        .then(res => {
            setTokenBalances(res.data)
            setLoading(false)
        })

    },[])




    return {
        loading , tokenBalances
    }
} 
// Point d'extension pour l'exécution des ordres.
//
// Cette version n'embarque volontairement QUE le courtier « papier » : aucune clé privée,
// aucun wallet, aucune transaction réelle. Les mesures du projet montrent que la stratégie
// testée perd de l'argent (voir README) ; brancher un courtier réel n'a donc pas de sens ici.

export interface TradeResult {
  success: boolean;
  /** Toujours true avec le courtier papier. */
  paper: boolean;
  signature?: string;
  error?: string;
}

export interface Broker {
  buy(mint: string, amountSol: number): Promise<TradeResult>;
  /** `amount` : nombre de tokens ou pourcentage du solde (« 100% »). */
  sell(mint: string, amount: number | string): Promise<TradeResult>;
}

export class PaperBroker implements Broker {
  async buy(mint: string, amountSol: number): Promise<TradeResult> {
    console.log(`[paper] achat ${amountSol} SOL sur ${mint} — simulé, aucune transaction envoyée`);
    return { success: true, paper: true };
  }

  async sell(mint: string, amount: number | string): Promise<TradeResult> {
    console.log(`[paper] vente ${amount} sur ${mint} — simulé, aucune transaction envoyée`);
    return { success: true, paper: true };
  }
}

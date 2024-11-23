mod util;


// Demonstrates how to use portal contracts to swap on L1 Uniswap with funds on L2
// Has two separate flows for private and public respectively
// Uses the token bridge contract, which tells which input token we need to talk to and handles the exit funds to L1
use dep::aztec::macros::aztec;

#[aztec]
contract Uniswap {

    use dep::aztec::prelude::{AztecAddress, EthAddress, FunctionSelector, SharedImmutable};


    use dep::auth_wit::auth::{
        assert_current_call_valid_authwith_public,
        compute_authwit_message_hash_from_call,
        set_authorized
    }

    use crate::util::{compute_swap_private_content_hash, compute_swap_public_content_hash};

    use dep::aztec::macros::{
        functions::{initializer, 
                    internal, 
                    private, 
                    public, 
                    view},
        storage::storage
    };

    use dep::token::Token;
    use dep::token_bridge::TokenBridge;

    #[storage]
    struct Storage<Context> {
        portal_address: SharedImmutable<EthAddress, Context>,
    }

    #[public]
    #[initializer]
    fn constructor(portal_address: EthAddress) {
        storage.portal_address.initialize(portal_address);
    }


    #[public]
    fn swap_public(sender: AztecAddress, 
                input_asset_bridge: AztecAddress, 
                input_amount: Field, 
                output_asset_bridge: AztecAddress, 
                output_amount_min: Field
                // params for using the transfer approval
                nonce_for_transfer_approval: Field,
                // params for the swap
                uniswap_fee_tier: Field,
                minimum_output_amount: Field,
                // params for the depositing output_asset back to Aztec
                recipient: AztecAddress,
                secret_hash_for_L1_to_L2_message: Field,
                caller_on_L1: EthAddress,
                // nonce for someone to call swap on sender's behalf
                nonce_for_swap_approval: Field) {
} {

    if(!sender.eq(context.msg_sender())) {
        assert_current_call_valid_authwit_public(&mut context, sender);

    }

    let input_asset = TokenBridge::at(input_asset_bridge).get_token().view(&mut context);


    // Transfer funds to this contract
    Token::at(input_asset).transfer_public( sender, 
                                            context.this_address(), 
                                            input_amount, 
                                            nonce_for_transfer_approval).call(&mut context);

     // Approve bridge to burn this contract's funds and exit to L1 Uniswap Portal
     Uniswap::at(context.this_address())
     ._approve_bridge_and_exit_input_asset_to_L1(
        input_asset,
        input_asset_bridge,
        input_amount
     ).call(&mut context);

    // Create swap message and send to Outbox for Uniswap Portal
    // this ensures the integrity of what the user originally intends to do on L1.
     let input_asset_bridge_portal_address = TokenBridge::at(input_asset_bridge).get_portal_address().view(&mut context);
     let output_asset_bridge_portal_address = TokenBridge::at(output_asset_bridge).get_portal_address().view(&mut context);

     // ensure portal exists - else funds might be lost
     assert(
        !input_asset_bridge_portal_address.is_zero(),
        "L1 portal address of input asset's bridge is 0"
     );

     assert(
        !output_asset_bridge_portal_address.is_zero(),
        "L1 portal address of output asset's bridge is 0"
     ); 

     let content_hash = compute_swap_public_content_hash(
        input_asset_bridge_portal_address,
        input_amount,
        uniswap_fee_tier,
        output_asset_bridge_portal_address,
        minimum_output_amount,
        recipient,
        secret_hash_for_L1_to_L2_message,
        caller_on_L1,
     );

     context.message_portal(storage.portal_ddress.read_public(), content_hash)


}

    #[public]
    #[internal]
    fn _approve_bridge_exist_input_asset_to_L1(
        token: AztecAddress,
        token_bridge: AztecAddress,
        amount: Field
    ) {
        // Since we will authorize and instantly spend the funds, all in public, we can use the same nonce
        // every interaction. In practice, the authwit should be squashed, so this is also cheap!
        let nonce = 0xdeadbeef;

        let selector = FunctionSelector::from_signature("burn_public((Field), Field, Field)");
        let message_hash = compute_authwit_message_hash_from_call(token_bridge, 
                                                                  token, 
                                                                  context.chain_id(), 
                                                                  context.chain_id(), 
                                                                  context.version(), 
                                                                  selector, 
                                                                  [context.this_address().to_field, amount, nonce]);

        // We need to make a call to update it.
        set_authorized(&mut context, message_hash, true);

        // Exit to L1 Uniswap Portal !
        let this_portal_address = storage.portal_address.read_public();

        // Exit to L1 Uniswap Portal !
        TokenBridge::at(token_bridge)
        .exit_to_l1_public(this_portal_address, amount, this_portal_address, nonce)
        .call(&mut context);
    }

    #[public]
    #[internal]
    #[view]
    fn _assert_token_is_same(token: AztecAddress, token_bridge: AztecAddress) {
        assert(
            token.eq(TokenBridge::at(token_bridge).get_token().view(&mut context)),
            "input_asset address is not the same as seen in the bridge contract",
        );
    }

}
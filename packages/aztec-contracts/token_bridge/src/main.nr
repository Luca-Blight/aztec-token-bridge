use dep::aztec::macros::aztec;

// Minimal implementation of the token bridge that can move funds between L1 <> L2.
// The bridge has a corresponding Portal contract on L1 that it is attached to
// And corresponds to a Token on L2 that uses the `AuthWit` accounts pattern.
// Bridge has to be set as a minter on the token before it can be used

#[aztec]
contract TokenBridge {
    use dep::aztec::prelude::{AztecAddress, EthAddress, PublicMutable, SharedImmutable};
    use dep::token_portal_content_hash_lib::{
        get_mint_private_content_hash, get_mint_public_content_hash, get_withdraw_content_hash,
    };

    use dep::token::Token;

    use dep::aztec::macros::{
        functions::{initializer, internal, private, public, view},
        storage::storage,
    };

    #[storage]
    struct Storage<Context> {
        token: PublicMutable<AztecAddress, Context>,
        portal_address: SharedImmutable<EthAddress, Context>,
    }

    #[public]
    #[initializer]
    fn constructor(token: AztecAddress, portal_address: EthAddress) {
        storage.token.write(token); // why does this use write and the other doesn't?
        storage.portal_address.initialize(portal_address);
    }

    ///////////////////////// Claim public & private /////////////////////////

    // both functions consume a L1->L2 message and mint the appropriate amount of tokens
    // burn comes before the message following the check-effect-interaction pattern

    // Consumes a L1->L2 message and calls the token contract to mint the appropriate amount publicly
    #[public]
    fn claim_public(to: AztecAddress, amount: Field, secret: Field, message_leaf_index: Field) {
        let content_hash = get_mint_public_content_hash(to, amount);

        // Consume message and emit nullifier
        context.consume_l1_to_l2_message(
            content_hash,
            secret,
            storage.portal_address.read_public(),
            message_leaf_index,
        );

        // Mint tokens
        Token::at(storage.token.read()).mint_public(to, amount).call(&mut context);
    }

    // Consumes a L1->L2 message and calls the token contract to mint the appropriate amount in private assets
    // User needs to call token.redeem_shield() to get the private assets
    // TODO(#8416): Consider creating a truly private claim flow.
    #[private]
    fn claim_private(
        secret_hash_for_redeeming_minted_notes: Field, // secret hash used to redeem minted notes at a later time. This enables anyone to call this function and mint tokens to a user on their behalf
        amount: Field,
        secret_for_L1_to_L2_message_consumption: Field, // secret used to consume the L1 to L2 message
        message_leaf_index: Field,
    ) {
        // Consume L1 to L2 message and emit nullifier
        let content_hash =
            get_mint_private_content_hash(secret_hash_for_redeeming_minted_notes, amount);
        context.consume_l1_to_l2_message(
            content_hash,
            secret_for_L1_to_L2_message_consumption,
            storage.portal_address.read_private(),
            message_leaf_index,
        );

        // Mint tokens on L2
        // `mint_private` on token is public. So we call an internal public function
        // which then calls the public method on the token contract.
        // Since the secret_hash is passed, no secret is leaked.
        TokenBridge::at(context.this_address())
            ._call_mint_on_token(amount, secret_hash_for_redeeming_minted_notes)
            .enqueue(&mut context);
    }

    // This is a public call as we need to read from public storage.
    // Also, note that user hashes their secret in private and only sends the hash in public
    // meaning only user can `redeem_shield` at a later time with their secret.
    #[public]
    #[internal]
    fn _call_mint_on_token(amount: Field, secret_hash: Field) {
        Token::at(storage.token.read()).mint_private_old(amount, secret_hash).call(&mut context);
    }

    ///////////////////////// Exit to L1 public & private /////////////////////////
    // both functions burn the appropriate amount of tokens and create a L2 to L1 withdraw message
    // public does not requiire a token address as it is publicly stored, enables anyone to call
    // nonce refer to approval message to let bridge burn tokens on behalf of the user
    // For both the public and private flow, we use the same mechanism to determine the content hash
    // This is because on L1 things are public anyway. The only difference between the two functions is that in the private domain we have to nullify users notes where as in the public domain we subtract the balance from the user

    #[public]
    fn exit_to_l1_public(
        recipient: EthAddress,
        amount: Field,
        caller_on_l1: EthAddress,
        nonce: Field,
    ) {
        // Send an L2 to L1 message
        let content = get_withdraw_content_hash(recipient, amount, caller_on_l1); // third arg is who can withdraw, what's the difference between recipient?
        // passes this to kernel circuit, creates a proof for the transactions and gets added as part of transactions data published by sequence and is stored in the contract
        context.message_portal(storage.portal_address.read_public(), content);

        // Burn tokens
        Token::at(storage.token.read()).burn_public(context.msg_sender(), amount, nonce).call(
            &mut context,
        );
    }

    // Burns the appropriate amount of tokens and creates a L2 to L1 withdraw message privately
    // Requires `msg.sender` (caller of the method) to give approval to the bridge to burn tokens on their behalf using witness signatures
    #[private]
    fn exit_to_l1_private(
        token: AztecAddress,
        recipient: EthAddress, // ethereum address to withdraw to
        amount: Field,
        caller_on_l1: EthAddress, // ethereum address that can call this function on the L1 portal (0x0 if anyone can call)
        nonce: Field, // nonce used in the approval message by `msg.sender` to let bridge burn their tokens on L2
    ) {
        // Send an L2 to L1 message
        let content = get_withdraw_content_hash(recipient, amount, caller_on_l1);

        // passes this to kernel circuit, creates a proof for the transactions and gets added as part of transactions data published by sequence and is stored in the contract
        context.message_portal(storage.portal_address.read_private(), content);

        // Assert that user provided token address is same as seen in storage.
        TokenBridge::at(context.this_address())._assert_token_is_same(token).enqueue(&mut context);

        // Burn tokens
        Token::at(token).burn(context.msg_sender(), amount, nonce).call(&mut context);
    }

    #[public]
    #[internal] // Since this is a private method, it can't read what token is publicly stored. So instead the user passes a token address, and _assert_token_is_same() checks that this user provided address is same as the one in storage.
    fn _assert_token_is_same(token: AztecAddress) {
        assert(storage.token.read().eq(token), "Token address is not the same as seen in storage");
    }


    #[public]       
    #[view]
    fn get_token() -> AztecAddress {
        storage.token.read()
    }

    // The sequencer just sees a request to execute_assert_token_is_same
    // and therefore has no context on what the appropriate private method was. If the assertion fails, then the kernel circuit will fail to create a proof and hence the transaction will be dropped.
}

// public functions executed by the sequence
// private methods are executed locally, all public calls are always after all private calls are completed.
// first burn happens only after the sequence asserts that the token is the same

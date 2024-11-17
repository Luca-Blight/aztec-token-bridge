pragma solidity ^0.8.0;

import "@openzeppelin/contracts/token/ERC20/ERC20.sol";

// deposit funds on L1 that a user may have into an Aztec portal and send a message to the Aztec rollup to mint tokens publicly on Aztec.

contract TestERC20 is ERC20 {
  constructor() ERC20("Portal", "PORTAL") {}

  function mint(address to, uint256 amount) external {
    _mint(to, amount);
  }
}
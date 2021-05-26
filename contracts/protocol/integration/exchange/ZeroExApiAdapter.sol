/*
    Copyright 2021 Set Labs Inc.

    Licensed under the Apache License, Version 2.0 (the "License");
    you may not use this file except in compliance with the License.
    You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

    Unless required by applicable law or agreed to in writing, software
    distributed under the License is distributed on an "AS IS" BASIS,
    WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
    See the License for the specific language governing permissions and
    limitations under the License.

    SPDX-License-Identifier: Apache License, Version 2.0
*/

pragma solidity 0.6.10;
pragma experimental "ABIEncoderV2";

/**
 * @title ZeroExApiAdapter
 * @author Set Protocol
 *
 * Exchange adapter for 0xAPI that returns data for swaps
 */

contract ZeroExApiAdapter {

    struct BatchFillData {
        address inputToken;
        address outputToken;
        uint256 sellAmount;
        WrappedBatchCall[] calls;
    }

    struct WrappedBatchCall {
        bytes4 selector;
        uint256 sellAmount;
        bytes data;
    }

    struct MultiHopFillData {
        address[] tokens;
        uint256 sellAmount;
        WrappedMultiHopCall[] calls;
    }

    struct WrappedMultiHopCall {
        bytes4 selector;
        bytes data;
    }

    /* ============ State Variables ============ */

    // ETH pseudo-token address used by 0x API.
    address private constant ETH_ADDRESS = 0xEeeeeEeeeEeEeeEeEeEeeEEEeeeeEeeeeeeeEEeE;

    // Minimum byte size of a single hop Uniswap V3 encoded path (token address + fee + token adress)
    uint256 private constant UNISWAP_V3_SINGLE_HOP_PATH_SIZE = 20 + 3 + 20;
    // Byte size of one hop in the Uniswap V3 encoded path (token address + fee)
    uint256 private constant UNISWAP_V3_SINGLE_HOP_OFFSET_SIZE = 20 + 3;

    // Address of the deployed ZeroEx contract.
    address public immutable zeroExAddress;

    // Returns the address to approve source tokens to for trading. This is the TokenTaker address
    address public immutable getSpender;

    /* ============ constructor ============ */

    constructor(address _zeroExAddress) public {
        zeroExAddress = _zeroExAddress;
        getSpender = _zeroExAddress;
    }


    /* ============ External Getter Functions ============ */

    /**
     * Return 0xAPI calldata which is already generated from 0xAPI
     *
     * @param  _sourceToken              Address of source token to be sold
     * @param  _destinationToken         Address of destination token to buy
     * @param  _destinationAddress       Address that assets should be transferred to
     * @param  _sourceQuantity           Amount of source token to sell
     * @param  _minDestinationQuantity   Min amount of destination token to buy
     * @param  _data                     Arbitrage bytes containing trade call data
     *
     * @return address                   Target contract address
     * @return uint256                   Call value
     * @return bytes                     Trade calldata
     */
    function getTradeCalldata(
        address _sourceToken,
        address _destinationToken,
        address _destinationAddress,
        uint256 _sourceQuantity,
        uint256 _minDestinationQuantity,
        bytes calldata _data
    )
        external
        view
        returns (address, uint256, bytes memory)
    {
        // solium-disable security/no-inline-assembly
        address inputToken;
        address outputToken;
        address recipient;
        bool supportsRecipient;
        uint256 inputTokenAmount;
        uint256 minOutputTokenAmount;

        {
            require(_data.length >= 4, "Invalid calldata");
            bytes4 selector;
            assembly {
                selector := and(
                    // Read the first 4 bytes of the _data array from calldata.
                    calldataload(add(36, calldataload(164))), // 164 = 5 * 32 + 4
                    0xffffffff00000000000000000000000000000000000000000000000000000000
                )
            }

            if (selector == 0x415565b0) {
                // transformERC20()
                (inputToken, outputToken, inputTokenAmount, minOutputTokenAmount) =
                    abi.decode(_data[4:], (address, address, uint256, uint256));
            } else if (selector == 0xf7fcd384) {
                // sellToLiquidityProvider()
                (inputToken, outputToken, , recipient, inputTokenAmount, minOutputTokenAmount) =
                    abi.decode(_data[4:], (address, address, address, address, uint256, uint256));
                supportsRecipient = true;
            } else if (selector == 0xd9627aa4) {
                // sellToUniswap()
                address[] memory path;
                (path, inputTokenAmount, minOutputTokenAmount) =
                    abi.decode(_data[4:], (address[], uint256, uint256));
                require(path.length > 1, "Uniswap token path too short");
                inputToken = path[0];
                outputToken = path[path.length - 1];
            } else if (selector == 0xafc6728e) {
                // batchFill()
                BatchFillData memory fillData;
                (fillData, minOutputTokenAmount) =
                    abi.decode(_data[4:], (BatchFillData, uint256));
                inputToken = fillData.inputToken;
                outputToken = fillData.outputToken;
                inputTokenAmount = fillData.sellAmount;
            } else if (selector == 0x21c184b6) {
                // multiHopFill()
                MultiHopFillData memory fillData;
                (fillData, minOutputTokenAmount) =
                    abi.decode(_data[4:], (MultiHopFillData, uint256));
                require(fillData.tokens.length > 1, "Multihop token path too short");
                inputToken = fillData.tokens[0];
                outputToken = fillData.tokens[fillData.tokens.length - 1];
                inputTokenAmount = fillData.sellAmount;
            } else if (selector == 0x6af479b2) {
                // sellTokenForTokenToUniswapV3()
                bytes memory encodedPath;
                (encodedPath, inputTokenAmount, minOutputTokenAmount, recipient) =
                    abi.decode(_data[4:], (bytes, uint256, uint256, address));
                supportsRecipient = true;
                (inputToken, outputToken) = _decodeTokensFromUniswapV3EncodedPath(encodedPath);
            } else if (selector == 0x803ba26d) {
                // sellTokenForEthToUniswapV3()
                bytes memory encodedPath;
                (encodedPath, inputTokenAmount, minOutputTokenAmount, recipient) =
                    abi.decode(_data[4:], (bytes, uint256, uint256, address));
                supportsRecipient = true;
                (inputToken, outputToken) = _decodeTokensFromUniswapV3EncodedPath(encodedPath);
            } else if (selector == 0x3598d8ab) {
                // sellEthForTokenToUniswapV3()
                // TODO(kimpers): is this correct?
                inputTokenAmount = 0;
                bytes memory encodedPath;
                (encodedPath, minOutputTokenAmount, recipient) =
                    abi.decode(_data[4:], (bytes,  uint256, address));
                supportsRecipient = true;
                (inputToken, outputToken) = _decodeTokensFromUniswapV3EncodedPath(encodedPath);
            } else {
                revert("Unsupported 0xAPI function selector");
            }
        }

        require(inputToken == _sourceToken, "Mismatched input token");
        require(outputToken == _destinationToken, "Mismatched output token");
        require(!supportsRecipient || recipient == _destinationAddress, "Mismatched recipient");
        require(inputTokenAmount == _sourceQuantity, "Mismatched input token quantity");
        require(minOutputTokenAmount >= _minDestinationQuantity, "Mismatched output token quantity");

        return (
            zeroExAddress,
            // Note: Does not account for limit order protocol fees.
            inputToken == ETH_ADDRESS ? inputTokenAmount : 0,
            _data
        );
    }

    // Decode input and output tokens from arbitrary length encoded Uniswap V3 path
    function _decodeTokensFromUniswapV3EncodedPath(bytes memory encodedPath)
        private
        pure
        returns (
            address inputToken,
            address outputToken
        )
    {
        require(encodedPath.length > 20, "UniswapV3 token path too short");
        uint256 numHops = (encodedPath.length - 20)/UNISWAP_V3_SINGLE_HOP_OFFSET_SIZE;
        require(numHops > 0, "UniswapV3 token path too short");

        if (numHops == 1) {
            (inputToken, outputToken) = _decodePoolInfoFromPathWithOffset(encodedPath, 0);

        } else {
            uint256 lastPoolOffset = (numHops - 1) * UNISWAP_V3_SINGLE_HOP_OFFSET_SIZE;
            (inputToken,) = _decodePoolInfoFromPathWithOffset(encodedPath, 0);
            (, outputToken) = _decodePoolInfoFromPathWithOffset(encodedPath, lastPoolOffset);
        }
    }

    // Return the input and output token at a specified offset in the encoded Uniswap V3 path
    function _decodePoolInfoFromPathWithOffset(bytes memory encodedPath, uint256 offset)
        private
        pure
        returns (
            address inputToken,
            address outputToken
        )
    {
        require(encodedPath.length >= UNISWAP_V3_SINGLE_HOP_PATH_SIZE, "UniswapV3 token path too short");
        assembly {
            let p := add(encodedPath, 32)
            p := add(p, offset)
            inputToken := shr(96, mload(p))
            p := add(p, 20)
            // account for fee
            p := add(p, 3)
            outputToken := shr(96, mload(p))
        }
    }
}
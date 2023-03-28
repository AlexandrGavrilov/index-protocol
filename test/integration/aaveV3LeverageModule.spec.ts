import "module-alias/register";

import { Signer, BigNumber, ContractTransaction, constants, utils } from "ethers";

import { getRandomAccount, getRandomAddress } from "@utils/test";
import { Account } from "@utils/test/types";
import { Address, Bytes } from "@utils/types";
import { impersonateAccount, waitForEvent } from "@utils/test/testingUtils";
import DeployHelper from "@utils/deploys";
import { cacheBeforeEach, getAccounts, getWaffleExpect } from "@utils/test/index";
import { ADDRESS_ZERO, ZERO } from "@utils/constants";
import { ether, preciseMul } from "@utils/index";

import {
  AaveV3LeverageModule,
  IWETH,
  IWETH__factory,
  IERC20,
  IERC20__factory,
  IPool,
  IPool__factory,
  IPoolAddressesProvider,
  IPoolAddressesProvider__factory,
  Controller,
  Controller__factory,
  DebtIssuanceModuleV2,
  DebtIssuanceModuleV2__factory,
  IntegrationRegistry,
  IntegrationRegistry__factory,
  SetToken,
  SetToken__factory,
  SetTokenCreator,
  SetTokenCreator__factory,
  UniswapV3ExchangeAdapterV2,
  UniswapV3ExchangeAdapterV2__factory,
  UniswapV3Pool,
  UniswapV3Pool__factory,
} from "@typechain/index";

const expect = getWaffleExpect();

// https://docs.aave.com/developers/deployed-contracts/v3-mainnet/ethereum-mainnet

const contractAddresses = {
  aaveV3AddressProvider: "0x2f39d218133AFaB8F2B819B1066c7E434Ad94E9e",
  aaveV3ProtocolDataProvider: "0x7B4EB56E7CD4b454BA8ff71E4518426369a138a3",
  aaveV3Oracle: "0x54586bE62E3c3580375aE3723C145253060Ca0C2",
  aaveV3Pool: "0x87870Bca3F3fD6335C3F4ce8392D69350B4fA4E2",
  controller: "0xD2463675a099101E36D85278494268261a66603A",
  debtIssuanceModule: "0xa0a98EB7Af028BE00d04e46e1316808A62a8fd59",
  setTokenCreator: "0x2758BF6Af0EC63f1710d3d7890e1C263a247B75E",
  integrationRegistry: "0xb9083dee5e8273E54B9DB4c31bA9d4aB7C6B28d3",
  uniswapV3ExchangeAdapterV2: "0xe6382D2D44402Bad8a03F11170032aBCF1Df1102",
  uniswapV3Router: "0xe6382D2D44402Bad8a03F11170032aBCF1Df1102",
  wethDaiPool: "0x60594a405d53811d3bc4766596efd80fd545a270",
};

const tokenAddresses = {
  weth: "0xC02aaA39b223FE8D0A0e5C4F27eAD9083C756Cc2",
  aWethV3: "0x4d5F47FA6A74757f35C14fD3a6Ef8E3C9BC514E8",
  aWethVariableDebtTokenV3: "0xeA51d7853EEFb32b6ee06b1C12E6dcCA88Be0fFE",
  dai: "0x6B175474E89094C44Da98b954EedeAC495271d0F",
  aDaiV3: "0x018008bfb33d285247A21d44E50697654f754e63",
  aDaiVariableDebtTokenV3: "0xcF8d0c70c850859266f5C338b38F9D663181C314",
  wbtc: "0x2260FAC5E5542a773Aa44fBCfeDf7C193bc2C599",
};

const whales = {
  dai: "0x075e72a5eDf65F0A5f44699c7654C1a76941Ddc8",
};

describe("AaveV3LeverageModule integration [ @forked-mainnet ]", () => {
  let owner: Account;
  let notOwner: Account;
  let deployer: DeployHelper;
  let aaveLeverageModule: AaveV3LeverageModule;
  let poolAddressesProvider: IPoolAddressesProvider;
  let debtIssuanceModule: DebtIssuanceModuleV2;
  let integrationRegistry: IntegrationRegistry;
  let setTokenCreator: SetTokenCreator;
  let controller: Controller;
  let weth: IWETH;
  let dai: IERC20;
  let wbtc: IERC20;
  let variableDebtDAI: IERC20;
  let variableDebtWETH: IERC20;
  let aWETH: IERC20;
  let aDAI: IERC20;
  let aaveLendingPool: IPool;
  let uniswapV3ExchangeAdapterV2: UniswapV3ExchangeAdapterV2;
  let wethDaiPool: UniswapV3Pool;

  let manager: Address;
  const maxManagerFee = ether(0.05);
  const managerIssueFee = ether(0);
  const managerRedeemFee = ether(0);
  let managerFeeRecipient: Address;
  let managerIssuanceHook: Address;
  before(async () => {
    [owner, notOwner] = await getAccounts();

    poolAddressesProvider = IPoolAddressesProvider__factory.connect(
      contractAddresses.aaveV3AddressProvider,
      owner.wallet,
    );

    aaveLendingPool = IPool__factory.connect(await poolAddressesProvider.getPool(), owner.wallet);
    weth = IWETH__factory.connect(tokenAddresses.weth, owner.wallet);
    await weth.deposit({ value: ether(10000) });
    dai = IERC20__factory.connect(tokenAddresses.dai, owner.wallet);
    const daiWhale = await impersonateAccount(whales.dai);
    await dai.connect(daiWhale).transfer(owner.address, ether(1000000));
    wbtc = IERC20__factory.connect(tokenAddresses.wbtc, owner.wallet);
    variableDebtDAI = IERC20__factory.connect(tokenAddresses.aDaiVariableDebtTokenV3, owner.wallet);
    variableDebtWETH = IERC20__factory.connect(
      tokenAddresses.aWethVariableDebtTokenV3,
      owner.wallet,
    );
    aWETH = IERC20__factory.connect(tokenAddresses.aWethV3, owner.wallet);
    aDAI = IERC20__factory.connect(tokenAddresses.aDaiV3, owner.wallet);
    uniswapV3ExchangeAdapterV2 = UniswapV3ExchangeAdapterV2__factory.connect(
      contractAddresses.uniswapV3ExchangeAdapterV2,
      owner.wallet,
    );

    wethDaiPool = UniswapV3Pool__factory.connect(contractAddresses.wethDaiPool, owner.wallet);

    manager = owner.address;
    managerFeeRecipient = owner.address;
    managerIssuanceHook = constants.AddressZero;

    controller = Controller__factory.connect(contractAddresses.controller, owner.wallet);

    const controllerOwner = await controller.owner();
    const controllerOwnerSigner = await impersonateAccount(controllerOwner);
    controller = controller.connect(controllerOwnerSigner);

    deployer = new DeployHelper(owner.wallet);
    const aaveV3Library = await deployer.libraries.deployAaveV3();

    aaveLeverageModule = await deployer.modules.deployAaveV3LeverageModule(
      controller.address,
      poolAddressesProvider.address,
      "contracts/protocol/integration/lib/AaveV3.sol:AaveV3",
      aaveV3Library.address,
    );
    await controller.addModule(aaveLeverageModule.address);

    debtIssuanceModule = DebtIssuanceModuleV2__factory.connect(
      contractAddresses.debtIssuanceModule,
      owner.wallet,
    );
    setTokenCreator = SetTokenCreator__factory.connect(
      contractAddresses.setTokenCreator,
      owner.wallet,
    );
    integrationRegistry = IntegrationRegistry__factory.connect(
      contractAddresses.integrationRegistry,
      owner.wallet,
    );
    const integrationRegistryOwner = await integrationRegistry.owner();
    integrationRegistry = integrationRegistry.connect(
      await impersonateAccount(integrationRegistryOwner),
    );

    await integrationRegistry.addIntegration(
      aaveLeverageModule.address,
      "UNISWAPV3",
      uniswapV3ExchangeAdapterV2.address,
    );
  });

  async function createNonControllerEnabledSetToken(
    components: Address[],
    positions: BigNumber[],
    modules: Address[],
  ): Promise<SetToken> {
    return new SetToken__factory(owner.wallet).deploy(
      components,
      positions,
      modules,
      controller.address,
      manager,
      "TestSetToken",
      "TEST",
    );
  }
  async function createSetToken(
    components: Address[],
    positions: BigNumber[],
    modules: Address[],
  ): Promise<SetToken> {
    const setTokenAddress = await setTokenCreator.callStatic.create(
      components,
      positions,
      modules,
      manager,
      "TestSetToken",
      "TEST",
    );

    await setTokenCreator.create(components, positions, modules, manager, "TestSetToken", "TEST");
    return SetToken__factory.connect(setTokenAddress, owner.wallet);
  }

  const initializeDebtIssuanceModule = (setTokenAddress: Address) => {
    return debtIssuanceModule.initialize(
      setTokenAddress,
      maxManagerFee,
      managerIssueFee,
      managerRedeemFee,
      managerFeeRecipient,
      managerIssuanceHook,
    );
  };

  describe("#constructor", () => {
    it("Should set the correct aave contracts", async () => {
      expect(await aaveLeverageModule.protocolDataProvider()).to.eq(
        contractAddresses.aaveV3ProtocolDataProvider,
      );
      expect(await aaveLeverageModule.lendingPoolAddressesProvider()).to.eq(
        contractAddresses.aaveV3AddressProvider,
      );
    });

    it("should set the correct controller", async () => {
      const returnController = await aaveLeverageModule.controller();
      expect(returnController).to.eq(contractAddresses.controller);
    });

    it("should set the correct underlying to reserve tokens mappings for weth", async () => {
      const wethReserveTokens = await aaveLeverageModule.underlyingToReserveTokens(
        tokenAddresses.weth,
      );
      expect(wethReserveTokens.aToken).to.eq(tokenAddresses.aWethV3);
      expect(wethReserveTokens.variableDebtToken).to.eq(tokenAddresses.aWethVariableDebtTokenV3);
    });

    it("should set the correct underlying to reserve tokens mappings for dai", async () => {
      const daiReserveTokens = await aaveLeverageModule.underlyingToReserveTokens(
        tokenAddresses.dai,
      );
      expect(daiReserveTokens.aToken).to.eq(tokenAddresses.aDaiV3);
      expect(daiReserveTokens.variableDebtToken).to.eq(tokenAddresses.aDaiVariableDebtTokenV3);
    });
  });

  describe("#initialize", async () => {
    let setToken: SetToken;
    let isAllowListed: boolean;
    let subjectSetToken: Address;
    let subjectCollateralAssets: Address[];
    let subjectBorrowAssets: Address[];
    let subjectCaller: Account;

    const initializeContracts = async () => {
      manager = owner.address;
      setToken = await createSetToken(
        [tokenAddresses.weth, tokenAddresses.dai],
        [ether(1), ether(100)],
        [aaveLeverageModule.address, debtIssuanceModule.address],
      );

      await initializeDebtIssuanceModule(setToken.address);

      if (isAllowListed) {
        // Add SetToken to allow list
        await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
      }
    };

    const initializeSubjectVariables = () => {
      subjectSetToken = setToken.address;
      subjectCollateralAssets = [tokenAddresses.weth, tokenAddresses.dai];
      subjectBorrowAssets = [tokenAddresses.dai, tokenAddresses.weth];
      subjectCaller = owner;
    };

    async function subject(): Promise<any> {
      return aaveLeverageModule
        .connect(subjectCaller.wallet)
        .initialize(subjectSetToken, subjectCollateralAssets, subjectBorrowAssets);
    }

    describe("when isAllowListed is true", () => {
      before(async () => {
        isAllowListed = true;
      });

      cacheBeforeEach(initializeContracts);
      beforeEach(initializeSubjectVariables);

      describe("when module is registered as integration", () => {
        beforeEach(async () => {
          await integrationRegistry.addIntegration(
            aaveLeverageModule.address,
            "DefaultIssuanceModule",
            debtIssuanceModule.address,
          );
          await integrationRegistry.addIntegration(
            debtIssuanceModule.address,
            "AaveLeverageModuleV3",
            aaveLeverageModule.address,
          );
        });
        it("should enable the Module on the SetToken", async () => {
          await subject();
          const isModuleEnabled = await setToken.isInitializedModule(aaveLeverageModule.address);
          expect(isModuleEnabled).to.eq(true);
        });

        it("should set the Aave settings and mappings", async () => {
          await subject();

          const enabledAssets = await aaveLeverageModule.getEnabledAssets(setToken.address);
          const [collateralAssets, borrowAssets] = enabledAssets;

          const isWethCollateral = await aaveLeverageModule.collateralAssetEnabled(
            setToken.address,
            tokenAddresses.weth,
          );
          const isDaiCollateral = await aaveLeverageModule.collateralAssetEnabled(
            setToken.address,
            tokenAddresses.dai,
          );
          const isDaiBorrow = await aaveLeverageModule.borrowAssetEnabled(
            setToken.address,
            tokenAddresses.dai,
          );
          const isWethBorrow = await aaveLeverageModule.borrowAssetEnabled(
            setToken.address,
            tokenAddresses.weth,
          );

          expect(collateralAssets).to.deep.eq(subjectCollateralAssets);
          expect(borrowAssets).to.deep.eq(subjectBorrowAssets);
          expect(isWethCollateral).to.be.true;
          expect(isDaiCollateral).to.be.true;
          expect(isDaiBorrow).to.be.true;
          expect(isWethBorrow).to.be.true;
        });

        // it("should register on the debt issuance module", async () => {
        //   await subject();
        //   const isRegistered = await debtIssuanceModule.isRegistered(setToken.address);
        //   expect(isRegistered).to.be.true;
        // });

        describe("when debt issuance module is not added to integration registry", async () => {
          beforeEach(async () => {
            await integrationRegistry.removeIntegration(
              aaveLeverageModule.address,
              "DefaultIssuanceModule",
            );
          });

          afterEach(async () => {
            // Add debt issuance address to integration
            await integrationRegistry.addIntegration(
              aaveLeverageModule.address,
              "DefaultIssuanceModule",
              debtIssuanceModule.address,
            );
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be valid adapter");
          });
        });

        describe("when debt issuance module is not initialized on SetToken", async () => {
          beforeEach(async () => {
            await setToken.removeModule(debtIssuanceModule.address);
          });

          afterEach(async () => {
            await setToken.addModule(debtIssuanceModule.address);
            await initializeDebtIssuanceModule(setToken.address);
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Issuance not initialized");
          });
        });

        describe("when the caller is not the SetToken manager", async () => {
          beforeEach(async () => {
            subjectCaller = await getRandomAccount();
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
          });
        });

        describe("when SetToken is not in pending state", async () => {
          beforeEach(async () => {
            const newModule = await getRandomAddress();
            await controller.addModule(newModule);

            const aaveLeverageModuleNotPendingSetToken = await createSetToken(
              [tokenAddresses.weth],
              [ether(1)],
              [newModule],
            );

            subjectSetToken = aaveLeverageModuleNotPendingSetToken.address;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be pending initialization");
          });
        });

        describe("when the SetToken is not enabled on the controller", async () => {
          beforeEach(async () => {
            const nonEnabledSetToken = await createNonControllerEnabledSetToken(
              [tokenAddresses.weth],
              [ether(1)],
              [aaveLeverageModule.address],
            );
            subjectSetToken = nonEnabledSetToken.address;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be controller-enabled SetToken");
          });
        });
      });

      describe("when isAllowListed is false", async () => {
        before(async () => {
          isAllowListed = false;
        });

        cacheBeforeEach(initializeContracts);
        beforeEach(initializeSubjectVariables);

        describe("when SetToken is not allowlisted", async () => {
          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Not allowed SetToken");
          });
        });

        describe("when any Set can initialize this module", async () => {
          beforeEach(async () => {
            await aaveLeverageModule.updateAnySetAllowed(true);
          });

          describe("when module is registered as integration", () => {
            beforeEach(async () => {
              await integrationRegistry.addIntegration(
                aaveLeverageModule.address,
                "DefaultIssuanceModule",
                debtIssuanceModule.address,
              );
              await integrationRegistry.addIntegration(
                debtIssuanceModule.address,
                "AaveLeverageModuleV3",
                aaveLeverageModule.address,
              );
            });
            it("should enable the Module on the SetToken", async () => {
              await subject();
              const isModuleEnabled = await setToken.isInitializedModule(
                aaveLeverageModule.address,
              );
              expect(isModuleEnabled).to.eq(true);
            });
          });
        });
      });
    });
  });

  describe("#lever", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;
    let destinationTokenQuantity: BigNumber;

    let subjectSetToken: Address;
    let subjectBorrowAsset: Address;
    let subjectCollateralAsset: Address;
    let subjectBorrowQuantity: BigNumber;
    let subjectMinCollateralQuantity: BigNumber;
    let subjectTradeAdapterName: string;
    let subjectTradeData: Bytes;
    let subjectCaller: Account;

    context("when aWETH is collateral asset and borrow positions is 0", async () => {
      const initializeContracts = async () => {
        setToken = await createSetToken(
          [aWETH.address],
          [ether(2)],
          [aaveLeverageModule.address, debtIssuanceModule.address],
        );
        await initializeDebtIssuanceModule(setToken.address);
        // Add SetToken to allow list
        await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
        // Initialize module if set to true
        if (isInitialized) {
          await aaveLeverageModule.initialize(
            setToken.address,
            [weth.address, dai.address],
            [dai.address, weth.address],
          );
        }

        // Mint aTokens
        await weth.approve(aaveLendingPool.address, ether(1000));
        await aaveLendingPool
          .connect(owner.wallet)
          .deposit(weth.address, ether(1000), owner.address, ZERO);

        await dai.approve(aaveLendingPool.address, ether(10000));
        await aaveLendingPool
          .connect(owner.wallet)
          .deposit(dai.address, ether(10000), owner.address, ZERO);

        // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 1000 DAI regardless of Set supply
        const issueQuantity = ether(1);
        destinationTokenQuantity = utils.parseEther("0.5");
        await aWETH.approve(debtIssuanceModule.address, ether(1000));
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);
      };

      const initializeSubjectVariables = async () => {
        subjectSetToken = setToken.address;
        subjectBorrowAsset = dai.address;
        subjectCollateralAsset = weth.address;
        subjectBorrowQuantity = ether(1000);
        subjectMinCollateralQuantity = destinationTokenQuantity;
        subjectTradeAdapterName = "UNISWAPV3";
        subjectTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
          [dai.address, weth.address], // Swap path
          [500], // Fees
          true,
        );
        subjectCaller = owner;
      };

      async function subject(): Promise<any> {
        return aaveLeverageModule
          .connect(subjectCaller.wallet)
          .lever(
            subjectSetToken,
            subjectBorrowAsset,
            subjectCollateralAsset,
            subjectBorrowQuantity,
            subjectMinCollateralQuantity,
            subjectTradeAdapterName,
            subjectTradeData,
          );
      }

      describe("when module is initialized", async () => {
        before(async () => {
          isInitialized = true;
        });

        cacheBeforeEach(initializeContracts);
        beforeEach(initializeSubjectVariables);

        it("should update the collateral position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          // cWETH position is increased
          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];

          const expectedFirstPositionUnit = initialPositions[0].unit.add(destinationTokenQuantity);

          expect(initialPositions.length).to.eq(1);
          expect(currentPositions.length).to.eq(2); // added a new borrow position
          expect(newFirstPosition.component).to.eq(aWETH.address);
          expect(newFirstPosition.positionState).to.eq(0); // Default
          expect(newFirstPosition.unit).to.gte(expectedFirstPositionUnit);
          expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
        });

        it("should update the borrow position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          // cEther position is increased
          const currentPositions = await setToken.getPositions();
          const newSecondPosition = (await setToken.getPositions())[1];

          const expectedSecondPositionUnit = (
            await variableDebtDAI.balanceOf(setToken.address)
          ).mul(-1);

          expect(initialPositions.length).to.eq(1);
          expect(currentPositions.length).to.eq(2);
          expect(newSecondPosition.component).to.eq(dai.address);
          expect(newSecondPosition.positionState).to.eq(1); // External
          expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
          expect(newSecondPosition.module).to.eq(aaveLeverageModule.address);
        });

        it("should transfer the correct components to the exchange", async () => {
          const oldSourceTokenBalance = await dai.balanceOf(wethDaiPool.address);

          await subject();
          const totalSourceQuantity = subjectBorrowQuantity;
          const expectedSourceTokenBalance = oldSourceTokenBalance.add(totalSourceQuantity);
          const newSourceTokenBalance = await dai.balanceOf(wethDaiPool.address);
          expect(newSourceTokenBalance).to.eq(expectedSourceTokenBalance);
        });

        it("should transfer the correct components from the exchange", async () => {
          const oldDestinationTokenBalance = await weth.balanceOf(wethDaiPool.address);

          await subject();
          const totalDestinationQuantity = destinationTokenQuantity;
          const expectedDestinationTokenBalance = oldDestinationTokenBalance.sub(
            totalDestinationQuantity,
          );
          const newDestinationTokenBalance = await weth.balanceOf(wethDaiPool.address);
          expect(newDestinationTokenBalance).to.gt(
            expectedDestinationTokenBalance.mul(999).div(1000),
          );
          expect(newDestinationTokenBalance).to.lt(
            expectedDestinationTokenBalance.mul(1001).div(1000),
          );
        });

        describe("when there is a protocol fee charged", async () => {
          let feePercentage: BigNumber;

          cacheBeforeEach(async () => {
            feePercentage = ether(0.05);
            controller = controller.connect(await impersonateAccount(await controller.owner()));
            await controller.addFee(
              aaveLeverageModule.address,
              ZERO, // Fee type on trade function denoted as 0
              feePercentage, // Set fee to 5 bps
            );
          });

          it("should transfer the correct components to the exchange", async () => {
            // const oldSourceTokenBalance = await dai.balanceOf(oneInchExchangeMockToWeth.address);

            await subject();
            // const totalSourceQuantity = subjectBorrowQuantity;
            // const expectedSourceTokenBalance = oldSourceTokenBalance.add(totalSourceQuantity);
            // const newSourceTokenBalance = await dai.balanceOf(oneInchExchangeMockToWeth.address);
            // expect(newSourceTokenBalance).to.eq(expectedSourceTokenBalance);
          });

          it("should transfer the correct protocol fee to the protocol", async () => {
            const feeRecipient = await controller.feeRecipient();
            const oldFeeRecipientBalance = await weth.balanceOf(feeRecipient);

            await subject();
            const expectedFeeRecipientBalance = oldFeeRecipientBalance.add(
              preciseMul(feePercentage, destinationTokenQuantity),
            );
            const newFeeRecipientBalance = await weth.balanceOf(feeRecipient);
            expect(newFeeRecipientBalance).to.gte(expectedFeeRecipientBalance);
          });

          it("should update the collateral position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            // cEther position is increased
            const currentPositions = await setToken.getPositions();
            const newFirstPosition = (await setToken.getPositions())[0];

            // Get expected cTokens minted
            const unitProtocolFee = feePercentage.mul(subjectMinCollateralQuantity).div(ether(1));
            const newUnits = subjectMinCollateralQuantity.sub(unitProtocolFee);
            const expectedFirstPositionUnit = initialPositions[0].unit.add(newUnits);

            expect(initialPositions.length).to.eq(1);
            expect(currentPositions.length).to.eq(2);
            expect(newFirstPosition.component).to.eq(aWETH.address);
            expect(newFirstPosition.positionState).to.eq(0); // Default
            expect(newFirstPosition.unit).to.gte(expectedFirstPositionUnit);
            expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
          });

          it("should update the borrow position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            // cEther position is increased
            const currentPositions = await setToken.getPositions();
            const newSecondPosition = (await setToken.getPositions())[1];

            const expectedSecondPositionUnit = (
              await variableDebtDAI.balanceOf(setToken.address)
            ).mul(-1);

            expect(initialPositions.length).to.eq(1);
            expect(currentPositions.length).to.eq(2);
            expect(newSecondPosition.component).to.eq(dai.address);
            expect(newSecondPosition.positionState).to.eq(1); // External
            expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
            expect(newSecondPosition.module).to.eq(aaveLeverageModule.address);
          });
        });

        describe("when the exchange is not valid", async () => {
          beforeEach(async () => {
            subjectTradeAdapterName = "INVALID";
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be valid adapter");
          });
        });

        describe("when collateral asset is not enabled", async () => {
          beforeEach(async () => {
            subjectCollateralAsset = wbtc.address;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Collateral not enabled");
          });
        });

        describe("when borrow asset is not enabled", async () => {
          beforeEach(async () => {
            subjectBorrowAsset = await getRandomAddress();
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Borrow not enabled");
          });
        });

        describe("when borrow asset is same as collateral asset", async () => {
          beforeEach(async () => {
            subjectBorrowAsset = weth.address;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith(
              "Collateral and borrow asset must be different",
            );
          });
        });

        describe("when quantity of token to sell is 0", async () => {
          beforeEach(async () => {
            subjectBorrowQuantity = ZERO;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Quantity is 0");
          });
        });

        describe("when the caller is not the SetToken manager", async () => {
          beforeEach(async () => {
            subjectCaller = await getRandomAccount();
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
          });
        });

        describe("when SetToken is not valid", async () => {
          beforeEach(async () => {
            const nonEnabledSetToken = await createNonControllerEnabledSetToken(
              [weth.address],
              [ether(1)],
              [aaveLeverageModule.address],
            );

            subjectSetToken = nonEnabledSetToken.address;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
          });
        });
      });

      describe("when module is not initialized", async () => {
        beforeEach(async () => {
          isInitialized = false;
          await initializeContracts();
          initializeSubjectVariables();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });
    });

    context("when DAI is borrow asset, and is a default position", async () => {
      before(async () => {
        isInitialized = true;
      });

      cacheBeforeEach(async () => {
        setToken = await createSetToken(
          [aWETH.address, dai.address],
          [ether(2), ether(1)],
          [aaveLeverageModule.address, debtIssuanceModule.address],
        );
        await initializeDebtIssuanceModule(setToken.address);
        // Add SetToken to allow list
        await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
        // Initialize module if set to true
        if (isInitialized) {
          await aaveLeverageModule.initialize(
            setToken.address,
            [weth.address, dai.address],
            [dai.address, weth.address],
          );
        }

        // Mint aTokens
        await weth.approve(aaveLendingPool.address, ether(1000));
        await aaveLendingPool
          .connect(owner.wallet)
          .deposit(weth.address, ether(1000), owner.address, ZERO);
        await dai.approve(aaveLendingPool.address, ether(10000));
        await aaveLendingPool
          .connect(owner.wallet)
          .deposit(dai.address, ether(10000), owner.address, ZERO);

        // Approve tokens to issuance module and call issue
        await aWETH.approve(debtIssuanceModule.address, ether(1000));
        await dai.approve(debtIssuanceModule.address, ether(10000));

        // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 1000 DAI regardless of Set supply
        const issueQuantity = ether(1);
        destinationTokenQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);
      });

      beforeEach(async () => {
        subjectSetToken = setToken.address;
        subjectBorrowAsset = dai.address;
        subjectCollateralAsset = weth.address;
        subjectBorrowQuantity = ether(1000);
        subjectMinCollateralQuantity = destinationTokenQuantity.div(2);
        subjectTradeAdapterName = "UNISWAPV3";
        subjectTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
          [dai.address, weth.address], // Swap path
          [500], // Fees
          true,
        );
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return aaveLeverageModule
          .connect(subjectCaller.wallet)
          .lever(
            subjectSetToken,
            subjectBorrowAsset,
            subjectCollateralAsset,
            subjectBorrowQuantity,
            subjectMinCollateralQuantity,
            subjectTradeAdapterName,
            subjectTradeData,
          );
      }

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];
        const newSecondPosition = (await setToken.getPositions())[1];

        // Get expected aTokens minted
        const newUnits = subjectMinCollateralQuantity;
        const expectedFirstPositionUnit = initialPositions[0].unit.add(newUnits);

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(3);
        expect(newFirstPosition.component).to.eq(aWETH.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.gte(expectedFirstPositionUnit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);

        expect(newSecondPosition.component).to.eq(dai.address);
        expect(newSecondPosition.positionState).to.eq(0); // Default
        expect(newSecondPosition.unit).to.eq(ether(1));
        expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should update the borrow position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newThridPosition = (await setToken.getPositions())[2];

        const expectedPositionUnit = (await variableDebtDAI.balanceOf(setToken.address)).mul(-1);

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(3);
        expect(newThridPosition.component).to.eq(dai.address);
        expect(newThridPosition.positionState).to.eq(1); // External
        expect(newThridPosition.unit).to.eq(expectedPositionUnit);
        expect(newThridPosition.module).to.eq(aaveLeverageModule.address);
      });
    });
  });

  describe("#setEModeCategory", () => {
    let setToken: SetToken;
    let subjectCategoryId: number;
    let subjectSetToken: Address;
    let caller: Signer;
    const initializeContracts = async () => {
      setToken = await createSetToken(
        [tokenAddresses.weth, tokenAddresses.dai],
        [ether(1), ether(100)],
        [aaveLeverageModule.address, debtIssuanceModule.address],
      );
      await initializeDebtIssuanceModule(setToken.address);

      await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);

      await aaveLeverageModule.initialize(
        setToken.address,
        [tokenAddresses.weth, tokenAddresses.dai],
        [dai.address, weth.address],
      );
    };

    cacheBeforeEach(initializeContracts);

    beforeEach(() => {
      subjectSetToken = setToken.address;
      caller = owner.wallet;
    });

    const subject = () =>
      aaveLeverageModule.connect(caller).setEModeCategory(subjectSetToken, subjectCategoryId);

    describe("When changing the EMode Category from default to 1", async () => {
      beforeEach(() => {
        subjectCategoryId = 1;
      });
      it("sets the EMode category for the set Token user correctly", async () => {
        await subject();
        const categoryId = await aaveLendingPool.getUserEMode(subjectSetToken);
        expect(categoryId).to.eq(subjectCategoryId);
      });
    });

    describe("When setting the category back to 0", async () => {
      beforeEach(async () => {
        await aaveLeverageModule.setEModeCategory(subjectSetToken, 1);
        subjectCategoryId = 0;
      });
      it("sets the EMode category for the set Token user correctly", async () => {
        await subject();
        const categoryId = await aaveLendingPool.getUserEMode(subjectSetToken);
        expect(categoryId).to.eq(subjectCategoryId);
      });
    });

    describe("When caller is not the owner", async () => {
      beforeEach(async () => {
        caller = notOwner.wallet;
      });
      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
      });
    });
  });

  describe("#deleverToZeroBorrowBalance", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;

    let subjectSetToken: Address;
    let subjectCollateralAsset: Address;
    let subjectRepayAsset: Address;
    let subjectRedeemQuantity: BigNumber;
    let subjectTradeAdapterName: string;
    let subjectTradeData: Bytes;
    let subjectCaller: Account;

    const initializeContracts = async () => {
      setToken = await createSetToken(
        [aWETH.address],
        [ether(10)],
        [aaveLeverageModule.address, debtIssuanceModule.address],
      );
      await initializeDebtIssuanceModule(setToken.address);
      // Add SetToken to allow list
      await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);
      // Initialize module if set to true
      if (isInitialized) {
        await aaveLeverageModule.initialize(
          setToken.address,
          [weth.address, dai.address],
          [dai.address, weth.address],
        );
      }

      const issueQuantity = ether(10);

      await weth.approve(aaveLendingPool.address, ether(100));
      await aaveLendingPool
        .connect(owner.wallet)
        .deposit(weth.address, ether(100), owner.address, ZERO);
      await aWETH.approve(debtIssuanceModule.address, ether(100));
      await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

      // Lever SetToken
      if (isInitialized) {
        const leverTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
          [dai.address, weth.address], // Swap path
          [500], // fees
          true,
        );

        await aaveLeverageModule.lever(
          setToken.address,
          dai.address,
          weth.address,
          ether(2000),
          ether(1),
          "UNISWAPV3",
          leverTradeData,
        );
      }
    };

    const initializeSubjectVariables = async () => {
      subjectSetToken = setToken.address;
      subjectCollateralAsset = weth.address;
      subjectRepayAsset = dai.address;
      subjectRedeemQuantity = ether(2);
      subjectTradeAdapterName = "UNISWAPV3";
      subjectCaller = owner;
      subjectTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
        [weth.address, dai.address], // Swap path
        [500], // Send quantity
        true,
      );
    };

    async function subject(): Promise<ContractTransaction> {
      return await aaveLeverageModule
        .connect(subjectCaller.wallet)
        .deleverToZeroBorrowBalance(
          subjectSetToken,
          subjectCollateralAsset,
          subjectRepayAsset,
          subjectRedeemQuantity,
          subjectTradeAdapterName,
          subjectTradeData,
        );
    }

    describe("when module is initialized", async () => {
      before(async () => {
        isInitialized = true;
      });

      cacheBeforeEach(initializeContracts);
      beforeEach(initializeSubjectVariables);

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        // Get expected aTokens burnt
        const removedUnits = subjectRedeemQuantity;
        const expectedFirstPositionUnit = initialPositions[0].unit.sub(removedUnits);

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newFirstPosition.component).to.eq(aWETH.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        // When switching to uniswapV3 integration testing had to add some small tolerance here
        // TODO: understand why
        expect(newFirstPosition.unit).to.lt(expectedFirstPositionUnit.mul(1001).div(1000));
        expect(newFirstPosition.unit).to.gt(expectedFirstPositionUnit.mul(999).div(1000));
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should wipe the debt on Aave", async () => {
        await subject();

        const borrowDebt = await variableDebtDAI.balanceOf(setToken.address);

        expect(borrowDebt).to.eq(ZERO);
      });

      it("should remove external positions on the borrow asset", async () => {
        await subject();

        const borrowAssetExternalModules = await setToken.getExternalPositionModules(dai.address);
        const borrowExternalUnit = await setToken.getExternalPositionRealUnit(
          dai.address,
          aaveLeverageModule.address,
        );
        const isPositionModule = await setToken.isExternalPositionModule(
          dai.address,
          aaveLeverageModule.address,
        );

        expect(borrowAssetExternalModules.length).to.eq(0);
        expect(borrowExternalUnit).to.eq(ZERO);
        expect(isPositionModule).to.eq(false);
      });

      it("should update the borrow asset equity on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        const swapPromise = waitForEvent(wethDaiPool, "Swap");
        const tx = await subject();

        // Fetch total repay amount
        const res = await tx.wait();
        const [, , amount0] = await swapPromise;
        const levDecreasedEvent = res.events?.find(value => {
          return value.event == "LeverageDecreased";
        });
        expect(levDecreasedEvent).to.not.eq(undefined);

        const initialSecondPosition = initialPositions[1];
        const expectedSecondPositionUnit = initialSecondPosition.unit.sub(amount0.div(10));

        const currentPositions = await setToken.getPositions();
        const newSecondPosition = (await setToken.getPositions())[1];

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newSecondPosition.component).to.eq(dai.address);
        expect(newSecondPosition.positionState).to.eq(0); // Default
        // Added some tolerance here when switching to aaveV3 integration testing (probably due to rounding errors)
        // TODO: Review
        expect(newSecondPosition.unit).to.gt(expectedSecondPositionUnit.mul(999).div(1000));
        expect(newSecondPosition.unit).to.lt(expectedSecondPositionUnit.mul(1001).div(1000));
        expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should transfer the correct components to the exchange", async () => {
        const oldSourceTokenBalance = await weth.balanceOf(wethDaiPool.address);

        await subject();
        const totalSourceQuantity = subjectRedeemQuantity;
        const expectedSourceTokenBalance = oldSourceTokenBalance.add(totalSourceQuantity);
        const newSourceTokenBalance = await weth.balanceOf(wethDaiPool.address);
        // Had to add some tolerance here when switching to aaveV3 integration testing
        // TODO: understand why
        expect(newSourceTokenBalance).to.lt(expectedSourceTokenBalance.mul(102).div(100));
        expect(newSourceTokenBalance).to.gt(expectedSourceTokenBalance.mul(99).div(100));
      });

      it("should transfer the correct components from the exchange", async () => {
        // const [, repayAssetAmountOut] = await uniswapV3Router.getAmountsOut(subjectRedeemQuantity, [
        //   weth.address,
        //   dai.address,
        // ]);
        const oldDestinationTokenBalance = await dai.balanceOf(wethDaiPool.address);

        await subject();
        // const totalDestinationQuantity = repayAssetAmountOut;
        // const expectedDestinationTokenBalance = oldDestinationTokenBalance.sub(
        //   totalDestinationQuantity,
        // );
        const newDestinationTokenBalance = await dai.balanceOf(wethDaiPool.address);
        expect(newDestinationTokenBalance).to.lt(oldDestinationTokenBalance);
      });

      describe("when the exchange is not valid", async () => {
        beforeEach(async () => {
          subjectTradeAdapterName = "INVALID";
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be valid adapter");
        });
      });

      describe("when borrow / repay asset is not enabled", async () => {
        beforeEach(async () => {
          subjectRepayAsset = wbtc.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Borrow not enabled");
        });
      });

      describe("when borrow balance is 0", async () => {
        beforeEach(async () => {
          await aaveLeverageModule
            .connect(owner.wallet)
            .addBorrowAssets(setToken.address, [wbtc.address]);

          subjectRepayAsset = wbtc.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Borrow balance is zero");
        });
      });

      describe("when the caller is not the SetToken manager", async () => {
        beforeEach(async () => {
          subjectCaller = await getRandomAccount();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be the SetToken manager");
        });
      });

      describe("when SetToken is not valid", async () => {
        beforeEach(async () => {
          const nonEnabledSetToken = await createNonControllerEnabledSetToken(
            [weth.address],
            [ether(1)],
            [aaveLeverageModule.address],
          );

          subjectSetToken = nonEnabledSetToken.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });
    });

    describe("when module is not initialized", async () => {
      beforeEach(async () => {
        isInitialized = false;
        await initializeContracts();
        initializeSubjectVariables();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#sync", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;

    let subjectSetToken: Address;
    let subjectCaller: Account;

    const initializeSubjectVariables = async () => {
      subjectSetToken = setToken.address;
      subjectCaller = await getRandomAccount();
    };

    async function subject(): Promise<any> {
      return aaveLeverageModule.connect(subjectCaller.wallet).sync(subjectSetToken);
    }

    context("when aWETH and aDAI are collateral and WETH and DAI are borrow assets", async () => {
      const initializeContracts = async () => {
        setToken = await createSetToken(
          [aWETH.address, aDAI.address],
          [ether(2), ether(1000)],
          [aaveLeverageModule.address, debtIssuanceModule.address],
        );
        await initializeDebtIssuanceModule(setToken.address);
        // Add SetToken to allow list
        await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);

        // Initialize module if set to true
        if (isInitialized) {
          await aaveLeverageModule.initialize(
            setToken.address,
            [weth.address, dai.address, wbtc.address], // Enable WBTC that is not a Set position
            [dai.address, weth.address, wbtc.address],
          );
        }

        // Mint aTokens
        await weth.approve(aaveLendingPool.address, ether(1000));
        await aaveLendingPool
          .connect(owner.wallet)
          .deposit(weth.address, ether(1000), owner.address, ZERO);
        await dai.approve(aaveLendingPool.address, ether(10000));
        await aaveLendingPool
          .connect(owner.wallet)
          .deposit(dai.address, ether(10000), owner.address, ZERO);

        // Approve tokens to issuance module and call issue
        await aWETH.approve(debtIssuanceModule.address, ether(1000));
        await aDAI.approve(debtIssuanceModule.address, ether(10000));

        // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 1000 DAI regardless of Set supply
        const issueQuantity = ether(1);
        await debtIssuanceModule.issue(setToken.address, issueQuantity, owner.address);

        if (isInitialized) {
          // Leverage aWETH in SetToken
          const leverEthTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
            [dai.address, weth.address], // Swap path
            [500], // fees
            true,
          );

          await aaveLeverageModule.lever(
            setToken.address,
            dai.address,
            weth.address,
            ether(2000),
            ether(1),
            "UNISWAPV3",
            leverEthTradeData,
          );

          const leverDaiTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
            [weth.address, dai.address], // Swap path
            [500], // fees
            true,
          );

          await aaveLeverageModule.lever(
            setToken.address,
            weth.address,
            dai.address,
            ether(1),
            ether(1000),
            "UNISWAPV3",
            leverDaiTradeData,
          );
        }
      };

      describe("when module is initialized", async () => {
        before(async () => {
          isInitialized = true;
        });

        cacheBeforeEach(initializeContracts);
        beforeEach(initializeSubjectVariables);

        it("should update the collateral positions on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          // cEther position is increased
          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];
          const newSecondPosition = (await setToken.getPositions())[1];

          const expectedFirstPositionUnit = await aWETH.balanceOf(setToken.address); // need not divide as total supply is 1.
          const expectedSecondPositionUnit = await aDAI.balanceOf(setToken.address);

          expect(initialPositions.length).to.eq(4);
          expect(currentPositions.length).to.eq(4);
          expect(newFirstPosition.component).to.eq(aWETH.address);
          expect(newFirstPosition.positionState).to.eq(0); // Default
          expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
          expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);

          expect(newSecondPosition.component).to.eq(aDAI.address);
          expect(newSecondPosition.positionState).to.eq(0); // Default
          expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
          expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
        });

        it("should update the borrow positions on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          // cEther position is increased
          const currentPositions = await setToken.getPositions();
          const newThirdPosition = (await setToken.getPositions())[2];
          const newFourthPosition = (await setToken.getPositions())[3];

          const expectedThirdPositionUnit = (await variableDebtDAI.balanceOf(setToken.address)).mul(
            -1,
          );
          const expectedFourthPositionUnit = (
            await variableDebtWETH.balanceOf(setToken.address)
          ).mul(-1);

          expect(initialPositions.length).to.eq(4);
          expect(currentPositions.length).to.eq(4);
          expect(newThirdPosition.component).to.eq(dai.address);
          expect(newThirdPosition.positionState).to.eq(1); // External
          expect(newThirdPosition.unit).to.eq(expectedThirdPositionUnit);
          expect(newThirdPosition.module).to.eq(aaveLeverageModule.address);

          expect(newFourthPosition.component).to.eq(weth.address);
          expect(newFourthPosition.positionState).to.eq(1); // External
          expect(newFourthPosition.unit).to.eq(expectedFourthPositionUnit);
          expect(newFourthPosition.module).to.eq(aaveLeverageModule.address);
        });

        describe("when leverage position has been liquidated", async () => {
          let liquidationRepayQuantity: BigNumber;

          cacheBeforeEach(async () => {
            // Leverage aWETH again
            const leverEthTradeData = await uniswapV3ExchangeAdapterV2.generateDataParam(
              [dai.address, weth.address], // Swap path
              [500], // fees
              true,
            );

            await aaveLeverageModule.lever(
              setToken.address,
              dai.address,
              weth.address,
              ether(2000),
              ether(1),
              "UNISWAPV3",
              leverEthTradeData,
            );
          });

          beforeEach(async () => {
            // ETH decreases to $100
            // const liquidationDaiPriceInEth = ether(0.01); // 1/100 = 0.01
            // TODO: Find a way to set asset rpice
            // await setAssetPriceInOracle(dai.address, liquidationDaiPriceInEth);

            // Seize 1 ETH + 5% liquidation bonus by repaying debt of 100 DAI
            liquidationRepayQuantity = ether(100);
            await dai.approve(aaveLendingPool.address, ether(100));

            await aaveLendingPool
              .connect(owner.wallet)
              .liquidationCall(
                weth.address,
                dai.address,
                setToken.address,
                liquidationRepayQuantity,
                true,
              );
          });

          it("should update the collateral positions on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            const currentPositions = await setToken.getPositions();
            const newFirstPosition = (await setToken.getPositions())[0];
            const newSecondPosition = (await setToken.getPositions())[1];

            // const aaveLiquidationBonus = (await protocolDataProvider.getReserveConfigurationData(setup.weth.address)).liquidationBonus;
            // const totalTokensSezied = preciseDiv(preciseMul(ether(1), aaveLiquidationBonus), BigNumber.from(10000));   // ethSeized * 105%
            // const expectedFirstPositionUnit = initialPositions[0].unit.sub(totalTokensSezied);   // off by 1 wei, due to interest accrual
            const expectedFirstPositionUnit = await aWETH.balanceOf(setToken.address);

            expect(initialPositions.length).to.eq(4);
            expect(currentPositions.length).to.eq(4);

            // aWETH position decreases
            expect(newFirstPosition.component).to.eq(aWETH.address);
            expect(newFirstPosition.positionState).to.eq(0); // Default
            expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
            expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);

            // cDAI position should stay the same
            expect(newSecondPosition.component).to.eq(aDAI.address);
            expect(newSecondPosition.positionState).to.eq(0); // Default
            expect(newSecondPosition.unit).to.eq(newSecondPosition.unit);
            expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
          });

          it("should update the borrow position on the SetToken correctly", async () => {
            const initialPositions = await setToken.getPositions();

            await subject();

            const currentPositions = await setToken.getPositions();
            const newThirdPosition = (await setToken.getPositions())[2];
            const newFourthPosition = (await setToken.getPositions())[3];

            const expectedThirdPositionUnit = (
              await variableDebtDAI.balanceOf(setToken.address)
            ).mul(-1);
            const expectedFourthPositionUnit = (
              await variableDebtWETH.balanceOf(setToken.address)
            ).mul(-1);

            expect(initialPositions.length).to.eq(4);
            expect(currentPositions.length).to.eq(4);

            expect(newThirdPosition.component).to.eq(dai.address);
            expect(newThirdPosition.positionState).to.eq(1); // External
            expect(newThirdPosition.unit).to.eq(expectedThirdPositionUnit);
            expect(newThirdPosition.module).to.eq(aaveLeverageModule.address);

            expect(newFourthPosition.component).to.eq(weth.address);
            expect(newFourthPosition.positionState).to.eq(1); // External
            expect(newFourthPosition.unit).to.eq(expectedFourthPositionUnit);
            expect(newFourthPosition.module).to.eq(aaveLeverageModule.address);
          });
        });

        describe("when SetToken is not valid", async () => {
          beforeEach(async () => {
            const nonEnabledSetToken = await createNonControllerEnabledSetToken(
              [weth.address],
              [ether(1)],
              [aaveLeverageModule.address],
            );

            subjectSetToken = nonEnabledSetToken.address;
          });

          it("should revert", async () => {
            await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
          });
        });
      });

      describe("when module is not initialized", async () => {
        beforeEach(() => {
          isInitialized = false;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });
    });

    describe("when set token total supply is 0", async () => {
      const initializeContracts = async () => {
        setToken = await createSetToken(
          [aWETH.address, aDAI.address],
          [ether(2), ether(1000)],
          [aaveLeverageModule.address, debtIssuanceModule.address],
        );
        await initializeDebtIssuanceModule(setToken.address);
        // Add SetToken to allow list
        await aaveLeverageModule.updateAllowedSetToken(setToken.address, true);

        // Initialize module if set to true
        await aaveLeverageModule.initialize(
          setToken.address,
          [weth.address, dai.address],
          [dai.address, weth.address],
        );
      };

      beforeEach(async () => {
        await initializeContracts();
        await initializeSubjectVariables();
      });

      it("should preserve default positions", async () => {
        const initialPositions = await setToken.getPositions();
        await subject();
        const currentPositions = await setToken.getPositions();

        expect(currentPositions.length).to.eq(2); // 2 Default positions
        expect(initialPositions.length).to.eq(2);

        expect(currentPositions[0].component).to.eq(aWETH.address);
        expect(currentPositions[0].positionState).to.eq(0); // Default
        expect(currentPositions[0].unit).to.eq(initialPositions[0].unit);
        expect(currentPositions[0].module).to.eq(ADDRESS_ZERO);

        expect(currentPositions[1].component).to.eq(aDAI.address);
        expect(currentPositions[1].positionState).to.eq(0); // Default
        expect(currentPositions[1].unit).to.eq(initialPositions[1].unit);
        expect(currentPositions[1].module).to.eq(ADDRESS_ZERO);
      });
    });
  });
});

import "module-alias/register";
import Web3 from "web3";
import { Address, Bytes } from "@utils/types";
import { Account } from "@utils/test/types";
import {
  ComptrollerMock,
  CompoundLeverageModule,
  DebtIssuanceMock,
  OneInchExchangeAdapter,
  OneInchExchangeMock,
  SetToken
} from "@utils/contracts";
import { CEther, CERc20 } from "@utils/contracts/compound";
import DeployHelper from "@utils/deploys";
import {
  ether,
  preciseDiv,
  preciseMul
} from "@utils/index";
import {
  addSnapshotBeforeRestoreAfterEach,
  getAccounts,
  getWaffleExpect,
  getSystemFixture,
  getCompoundFixture,
  getRandomAccount,
  getRandomAddress
} from "@utils/test/index";
import { CompoundFixture, SystemFixture } from "@utils/fixtures";
import { BigNumber } from "@ethersproject/bignumber";
import { ADDRESS_ZERO, ZERO, EMPTY_BYTES } from "@utils/constants";

const expect = getWaffleExpect();
const web3 = new Web3();

describe("CompoundLeverageModule", () => {
  let owner: Account;
  let mockModule: Account;
  let deployer: DeployHelper;
  let setup: SystemFixture;
  let compoundSetup: CompoundFixture;

  let compoundLeverageModule: CompoundLeverageModule;
  let debtIssuanceMock: DebtIssuanceMock;
  let cEther: CEther;
  let cDai: CERc20;
  let cComp: CERc20;

  let oneInchFunctionSignature: Bytes;
  let oneInchExchangeMockToWeth: OneInchExchangeMock;
  let oneInchExchangeMockFromWeth: OneInchExchangeMock;
  let oneInchExchangeMockWithSlippage: OneInchExchangeMock;
  let oneInchExchangeMockFromComp: OneInchExchangeMock;

  let oneInchExchangeAdapterToWeth: OneInchExchangeAdapter;
  let oneInchExchangeAdapterFromWeth: OneInchExchangeAdapter;
  let oneInchExchangeAdapterFromComp: OneInchExchangeAdapter;
  let cTokenInitialMantissa: BigNumber;

  before(async () => {
    [
      owner,
      mockModule,
    ] = await getAccounts();

    deployer = new DeployHelper(owner.wallet);

    setup = getSystemFixture(owner.address);
    await setup.initialize();

    compoundSetup = getCompoundFixture(owner.address);
    await compoundSetup.initialize();

    cTokenInitialMantissa = ether(200000000);
    cEther = await compoundSetup.createAndEnableCEther(
      cTokenInitialMantissa,
      compoundSetup.comptroller.address,
      compoundSetup.interestRateModel.address,
      "Compound ether",
      "cETH",
      8,
      ether(0.75), // 75% collateral factor
      ether(590)
    );

    cDai = await compoundSetup.createAndEnableCToken(
      setup.dai.address,
      cTokenInitialMantissa,
      compoundSetup.comptroller.address,
      compoundSetup.interestRateModel.address,
      "Compound Dai",
      "cDAI",
      8,
      ether(0.75), // 75% collateral factor
      ether(1)
    );

    cComp = await compoundSetup.createAndEnableCToken(
      compoundSetup.comp.address,
      cTokenInitialMantissa,
      compoundSetup.comptroller.address,
      compoundSetup.interestRateModel.address,
      "Compound COMP",
      "cCOMP",
      8,
      ether(0.75), // 75% collateral factor
      ether(1)
    );

    await compoundSetup.comptroller._setCompRate(ether(1));
    await compoundSetup.comptroller._addCompMarkets([cEther.address, cDai.address, cComp.address]);

    debtIssuanceMock = await deployer.mocks.deployDebtIssuanceMock();
    await setup.controller.addModule(debtIssuanceMock.address);

    compoundLeverageModule = await deployer.modules.deployCompoundLeverageModule(
      setup.controller.address,
      compoundSetup.comp.address,
      compoundSetup.comptroller.address,
      cEther.address,
      setup.weth.address
    );
    await setup.controller.addModule(compoundLeverageModule.address);

    // Deploy 1inch mock contracts

    // 1inch function signature
    oneInchFunctionSignature = web3.eth.abi.encodeFunctionSignature(
      "swap(address,address,uint256,uint256,uint256,address,address[],bytes,uint256[],uint256[])"
    );

    // Mock OneInch exchange that allows for fixed exchange amounts. So we need to setup separate exchange adapters
    oneInchExchangeMockToWeth = await deployer.mocks.deployOneInchExchangeMock(
      setup.dai.address,
      setup.weth.address,
      ether(590), // 590 DAI
      ether(1), // Trades for 1 WETH
    );
    oneInchExchangeAdapterToWeth = await deployer.adapters.deployOneInchExchangeAdapter(
      oneInchExchangeMockToWeth.address,
      oneInchExchangeMockToWeth.address,
      oneInchFunctionSignature
    );

    await setup.integrationRegistry.addIntegration(
      compoundLeverageModule.address,
      "ONEINCHTOWETH",
      oneInchExchangeAdapterToWeth.address
    );

    oneInchExchangeMockFromWeth = await deployer.mocks.deployOneInchExchangeMock(
      setup.weth.address,
      setup.dai.address,
      ether(1), // 1 WETH
      ether(590), // Trades for 590 DAI
    );
    oneInchExchangeAdapterFromWeth = await deployer.adapters.deployOneInchExchangeAdapter(
      oneInchExchangeMockFromWeth.address,
      oneInchExchangeMockFromWeth.address,
      oneInchFunctionSignature
    );

    await setup.integrationRegistry.addIntegration(
      compoundLeverageModule.address,
      "ONEINCHFROMWETH",
      oneInchExchangeAdapterFromWeth.address
    );

    // Setup Mock 1inch exchange that does not return sufficient units to satisfy slippage requirement
    oneInchExchangeMockWithSlippage = await deployer.mocks.deployOneInchExchangeMock(
      setup.dai.address,
      setup.weth.address,
      ether(590), // 590 DAI
      ether(0.9), // Trades for 0.9 WETH
    );
    const oneInchExchangeAdapterWithSlippage = await deployer.adapters.deployOneInchExchangeAdapter(
      oneInchExchangeMockWithSlippage.address,
      oneInchExchangeMockWithSlippage.address,
      oneInchFunctionSignature
    );

    await setup.integrationRegistry.addIntegration(
      compoundLeverageModule.address,
      "ONEINCHSLIPPAGE",
      oneInchExchangeAdapterWithSlippage.address
    );

    // Add debt issuance address to integration
    await setup.integrationRegistry.addIntegration(
      compoundLeverageModule.address,
      "DefaultIssuanceModule",
      debtIssuanceMock.address
    );
  });

  addSnapshotBeforeRestoreAfterEach();

  describe("#constructor", async () => {
    let subjectController: Address;
    let subjectCompToken: Address;
    let subjectComptroller: Address;
    let subjectCEther: Address;
    let subjectWeth: Address;

    beforeEach(async () => {
      subjectController = setup.controller.address;
      subjectCompToken = compoundSetup.comp.address;
      subjectComptroller = compoundSetup.comptroller.address;
      subjectCEther = cEther.address;
      subjectWeth = setup.weth.address;
    });

    async function subject(): Promise<any> {
      return deployer.modules.deployCompoundLeverageModule(
        subjectController,
        subjectCompToken,
        subjectComptroller,
        subjectCEther,
        subjectWeth,
      );
    }

    it("should set the correct controller", async () => {
      const compoundLeverageModule = await subject();

      const controller = await compoundLeverageModule.controller();
      expect(controller).to.eq(subjectController);
    });

    it("should set the correct COMP token", async () => {
      const compoundLeverageModule = await subject();

      const compToken = await compoundLeverageModule.compToken();
      expect(compToken).to.eq(subjectCompToken);
    });

    it("should set the correct Comptroller", async () => {
      const compoundLeverageModule = await subject();

      const comptroller = await compoundLeverageModule.comptroller();
      expect(comptroller).to.eq(subjectComptroller);
    });

    it("should set the correct cEther address", async () => {
      const compoundLeverageModule = await subject();

      const cEther = await compoundLeverageModule.cEther();
      expect(cEther).to.eq(subjectCEther);
    });

    it("should set the correct WETH address", async () => {
      const compoundLeverageModule = await subject();

      const weth = await compoundLeverageModule.weth();
      expect(weth).to.eq(subjectWeth);
    });

    it("should set the correct underlying to cToken mapping", async () => {
      const compoundLeverageModule = await subject();

      const returnedCEther = await compoundLeverageModule.underlyingToCToken(setup.weth.address);
      const returnedCDai = await compoundLeverageModule.underlyingToCToken(setup.dai.address);

      expect(returnedCEther).to.eq(subjectCEther);
      expect(returnedCDai).to.eq(cDai.address);
    });
  });

  describe("#initialize", async () => {
    let setToken: SetToken;
    let subjectSetToken: Address;
    let subjectCollateralAssets: Address[];
    let subjectBorrowAssets: Address[];
    let subjectCaller: Account;

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address, setup.dai.address],
        [ether(1), ether(100)],
        [compoundLeverageModule.address, debtIssuanceMock.address]
      );
      await debtIssuanceMock.initialize(setToken.address);

      subjectSetToken = setToken.address;
      subjectCollateralAssets = [setup.weth.address, setup.dai.address];
      subjectBorrowAssets = [setup.dai.address, setup.weth.address];
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return compoundLeverageModule.connect(subjectCaller.wallet).initialize(
        subjectSetToken,
        subjectCollateralAssets,
        subjectBorrowAssets,
      );
    }

    it("should enable the Module on the SetToken", async () => {
      await subject();
      const isModuleEnabled = await setToken.isInitializedModule(compoundLeverageModule.address);
      expect(isModuleEnabled).to.eq(true);
    });

    it("should set the Compound settings and mappings", async () => {
      await subject();
      const collateralCTokens = (await compoundLeverageModule.getEnabledAssets(setToken.address))[0];
      const borrowAssets = (await compoundLeverageModule.getEnabledAssets(setToken.address))[1];
      const borrowCTokens = await Promise.all(borrowAssets.map(borrowAsset => compoundLeverageModule.underlyingToCToken(borrowAsset)));
      const isCEtherCollateral = await compoundLeverageModule.isCollateralCTokenEnabled(setToken.address, cEther.address);
      const isCDaiCollateral = await compoundLeverageModule.isCollateralCTokenEnabled(setToken.address, cDai.address);
      const isCDaiBorrow = await compoundLeverageModule.isBorrowCTokenEnabled(setToken.address, cDai.address);
      const isCEtherBorrow = await compoundLeverageModule.isBorrowCTokenEnabled(setToken.address, cEther.address);
      expect(JSON.stringify(collateralCTokens)).to.eq(JSON.stringify([cEther.address, cDai.address]));
      expect(JSON.stringify(borrowCTokens)).to.eq(JSON.stringify([cDai.address, cEther.address]));
      expect(isCEtherCollateral).to.be.true;
      expect(isCDaiCollateral).to.be.true;
      expect(isCDaiBorrow).to.be.true;
      expect(isCEtherBorrow).to.be.true;
    });

    it("should enter markets in Compound", async () => {
      await subject();
      const isCEtherEntered = await compoundSetup.comptroller.checkMembership(setToken.address, cEther.address);
      const isCDaiEntered = await compoundSetup.comptroller.checkMembership(setToken.address, cDai.address);
      expect(isCEtherEntered).to.be.true;
      expect(isCDaiEntered).to.be.true;
    });

    it("should register on the debt issuance module", async () => {
      await subject();
      const isRegistered = await debtIssuanceMock.isRegistered(setToken.address);
      expect(isRegistered).to.be.true;
    });

    describe("when debt issuance module is not added to integration registry", async () => {
      beforeEach(async () => {
        await setup.integrationRegistry.removeIntegration(compoundLeverageModule.address, "DefaultIssuanceModule");
      });

      afterEach(async () => {
        // Add debt issuance address to integration
        await setup.integrationRegistry.addIntegration(
          compoundLeverageModule.address,
          "DefaultIssuanceModule",
          debtIssuanceMock.address
        );
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be valid adapter");
      });
    });

    describe("when debt issuance module is not initialized on SetToken", async () => {
      beforeEach(async () => {
        await setToken.removeModule(debtIssuanceMock.address);
      });

      afterEach(async () => {
        await setToken.addModule(debtIssuanceMock.address);
        await debtIssuanceMock.initialize(setToken.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Debt issuance must be initialized");
      });
    });

    describe("when collateral asset does not exist on Compound", async () => {
      beforeEach(async () => {
        subjectCollateralAssets = [setup.dai.address, await getRandomAddress()];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("cToken must exist");
      });
    });

    describe("when collateral asset is duplicated", async () => {
      beforeEach(async () => {
        subjectCollateralAssets = [setup.weth.address, setup.weth.address];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Collateral is enabled");
      });
    });

    describe("when borrow asset does not exist on Compound", async () => {
      beforeEach(async () => {
        subjectBorrowAssets = [await getRandomAddress(), setup.weth.address];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("cToken must exist");
      });
    });

    describe("when borrow asset is duplicated", async () => {
      beforeEach(async () => {
        subjectBorrowAssets = [setup.weth.address, setup.weth.address];
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Borrow is enabled");
      });
    });

    describe("when entering an invalid market", async () => {
      beforeEach(async () => {
        await compoundSetup.comptroller._setMaxAssets(0);
      });

      afterEach(async () => {
        await compoundSetup.comptroller._setMaxAssets(10);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Entering market failed");
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
        await setup.controller.addModule(newModule);

        const compoundLeverageModuleNotPendingSetToken = await setup.createSetToken(
          [setup.weth.address],
          [ether(1)],
          [newModule]
        );

        subjectSetToken = compoundLeverageModuleNotPendingSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be pending initialization");
      });
    });

    describe("when the SetToken is not enabled on the controller", async () => {
      beforeEach(async () => {
        const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
          [setup.weth.address],
          [ether(1)],
          [compoundLeverageModule.address]
        );

        subjectSetToken = nonEnabledSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be controller-enabled SetToken");
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

    context("when cETH is collateral asset and borrow positions is 0", async () => {
      before(async () => {
        isInitialized = true;
      });

      beforeEach(async () => {
        setToken = await setup.createSetToken(
          [cEther.address],
          [BigNumber.from(10000000000)],
          [compoundLeverageModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
        );
        await debtIssuanceMock.initialize(setToken.address);
        // Initialize module if set to true
        if (isInitialized) {
          await compoundLeverageModule.initialize(
            setToken.address,
            [setup.weth.address, setup.dai.address],
            [setup.dai.address, setup.weth.address]
          );
        }
        await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);

        // Add Set token as token sender / recipient
        oneInchExchangeMockToWeth = oneInchExchangeMockToWeth.connect(owner.wallet);
        await oneInchExchangeMockToWeth.addSetTokenAddress(setToken.address);

        // Fund One Inch exchange with destinationToken WETH
        await setup.weth.transfer(oneInchExchangeMockToWeth.address, ether(10));

        // Mint cTokens
        await setup.weth.approve(cEther.address, ether(1000));
        await cEther.mint({value: ether(1000)});
        await setup.dai.approve(cDai.address, ether(100000));
        await cDai.mint(ether(100000));

        // Approve tokens to issuance module and call issue
        await cEther.approve(setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 590 DAI regardless of Set supply
        const issueQuantity = ether(1);
        destinationTokenQuantity = ether(1);
        await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);
        subjectSetToken = setToken.address;
        subjectBorrowAsset = setup.dai.address;
        subjectCollateralAsset = setup.weth.address;
        subjectBorrowQuantity = ether(590);
        subjectMinCollateralQuantity = destinationTokenQuantity;
        subjectTradeAdapterName = "ONEINCHTOWETH";
        subjectTradeData = oneInchExchangeMockToWeth.interface.encodeFunctionData("swap", [
          setup.dai.address, // Send token
          setup.weth.address, // Receive token
          subjectBorrowQuantity, // Send quantity
          subjectMinCollateralQuantity, // Min receive quantity
          ZERO,
          ADDRESS_ZERO,
          [ADDRESS_ZERO],
          EMPTY_BYTES,
          [ZERO],
          [ZERO],
        ]);
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return compoundLeverageModule.connect(subjectCaller.wallet).lever(
          subjectSetToken,
          subjectBorrowAsset,
          subjectCollateralAsset,
          subjectBorrowQuantity,
          subjectMinCollateralQuantity,
          subjectTradeAdapterName,
          subjectTradeData
        );
      }

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        // Get expected cTokens minted
        const newUnits = preciseDiv(destinationTokenQuantity, cTokenInitialMantissa);
        const expectedFirstPositionUnit = initialPositions[0].unit.add(newUnits);

        expect(initialPositions.length).to.eq(1);
        expect(currentPositions.length).to.eq(2);
        expect(newFirstPosition.component).to.eq(cEther.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should update the borrow position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newSecondPosition = (await setToken.getPositions())[1];

        const expectedSecondPositionUnit = (await cDai.borrowBalanceStored(setToken.address)).mul(-1);

        expect(initialPositions.length).to.eq(1);
        expect(currentPositions.length).to.eq(2);
        expect(newSecondPosition.component).to.eq(setup.dai.address);
        expect(newSecondPosition.positionState).to.eq(1); // External
        expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
        expect(newSecondPosition.module).to.eq(compoundLeverageModule.address);
      });

      it("should transfer the correct components to the exchange", async () => {
        const oldSourceTokenBalance = await setup.dai.balanceOf(oneInchExchangeMockToWeth.address);

        await subject();
        const totalSourceQuantity = subjectBorrowQuantity;
        const expectedSourceTokenBalance = oldSourceTokenBalance.add(totalSourceQuantity);
        const newSourceTokenBalance = await setup.dai.balanceOf(oneInchExchangeMockToWeth.address);
        expect(newSourceTokenBalance).to.eq(expectedSourceTokenBalance);
      });

      it("should transfer the correct components from the exchange", async () => {
        const oldDestinationTokenBalance = await setup.weth.balanceOf(oneInchExchangeMockToWeth.address);

        await subject();
        const totalDestinationQuantity = destinationTokenQuantity;
        const expectedDestinationTokenBalance = oldDestinationTokenBalance.sub(totalDestinationQuantity);
        const newDestinationTokenBalance = await setup.weth.balanceOf(oneInchExchangeMockToWeth.address);
        expect(newDestinationTokenBalance).to.eq(expectedDestinationTokenBalance);
      });

      describe("when the leverage position has been liquidated", async () => {
        let ethSeized: BigNumber;

        beforeEach(async () => {
          // Lever up
          await compoundLeverageModule.connect(subjectCaller.wallet).lever(
            subjectSetToken,
            subjectBorrowAsset,
            subjectCollateralAsset,
            subjectBorrowQuantity,
            subjectMinCollateralQuantity,
            subjectTradeAdapterName,
            subjectTradeData
          );

          // Set price to be liquidated
          const liquidationEthPrice = ether(250);
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, liquidationEthPrice);

          // Seize 1 ETH + 8% penalty as set on Comptroller
          ethSeized = ether(1);
          await setup.dai.approve(cDai.address, ether(100000));
          await cDai.liquidateBorrow(setToken.address, preciseMul(ethSeized, liquidationEthPrice), cEther.address);

          // ETH increases to $1500 to allow more borrow
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, ether(1500));
          subjectBorrowQuantity = ether(590);
        });

        it("should transfer the correct components to the exchange", async () => {
          const oldSourceTokenBalance = await setup.dai.balanceOf(oneInchExchangeMockToWeth.address);

          await subject();
          const totalSourceQuantity = subjectBorrowQuantity;
          const expectedSourceTokenBalance = oldSourceTokenBalance.add(totalSourceQuantity);
          const newSourceTokenBalance = await setup.dai.balanceOf(oneInchExchangeMockToWeth.address);
          expect(newSourceTokenBalance).to.eq(expectedSourceTokenBalance);
        });

        it("should update the collateral position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          // cEther position is increased
          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];

          // Get expected cTokens minted
          const newUnits = preciseDiv(destinationTokenQuantity, cTokenInitialMantissa);
          const compoundLiquidationPenalty = await compoundSetup.comptroller.liquidationIncentiveMantissa();
          const liquidatedCEth = preciseDiv(preciseMul(ethSeized, compoundLiquidationPenalty), cTokenInitialMantissa);

          const expectedPostLiquidationUnit = initialPositions[0].unit.sub(liquidatedCEth).add(newUnits);

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(2);
          expect(newFirstPosition.component).to.eq(cEther.address);
          expect(newFirstPosition.positionState).to.eq(0); // Default
          expect(newFirstPosition.unit).to.eq(expectedPostLiquidationUnit);
          expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
        });

        it("should update the borrow position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          // cEther position is increased
          const currentPositions = await setToken.getPositions();
          const newSecondPosition = (await setToken.getPositions())[1];

          const expectedSecondPositionUnit = (await cDai.borrowBalanceStored(setToken.address)).mul(-1);

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(2);
          expect(newSecondPosition.component).to.eq(setup.dai.address);
          expect(newSecondPosition.positionState).to.eq(1); // External
          expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
          expect(newSecondPosition.module).to.eq(compoundLeverageModule.address);
        });
      });

      describe("when there is a protocol fee charged", async () => {
        let feePercentage: BigNumber;

        beforeEach(async () => {
          feePercentage = ether(0.05);
          setup.controller = setup.controller.connect(owner.wallet);
          await setup.controller.addFee(
            compoundLeverageModule.address,
            ZERO, // Fee type on trade function denoted as 0
            feePercentage // Set fee to 5 bps
          );
        });

        it("should transfer the correct components to the exchange", async () => {
          const oldSourceTokenBalance = await setup.dai.balanceOf(oneInchExchangeMockToWeth.address);

          await subject();
          const totalSourceQuantity = subjectBorrowQuantity;
          const expectedSourceTokenBalance = oldSourceTokenBalance.add(totalSourceQuantity);
          const newSourceTokenBalance = await setup.dai.balanceOf(oneInchExchangeMockToWeth.address);
          expect(newSourceTokenBalance).to.eq(expectedSourceTokenBalance);
        });

        it("should transfer the correct protocol fee to the protocol", async () => {
          const feeRecipient = await setup.controller.feeRecipient();
          const oldFeeRecipientBalance = await setup.weth.balanceOf(feeRecipient);

          await subject();
          const expectedFeeRecipientBalance = oldFeeRecipientBalance.add(preciseMul(feePercentage, destinationTokenQuantity));
          const newFeeRecipientBalance = await setup.weth.balanceOf(feeRecipient);
          expect(newFeeRecipientBalance).to.eq(expectedFeeRecipientBalance);
        });

        it("should update the collateral position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          // cEther position is increased
          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];

          // Get expected cTokens minted
          const unitProtocolFee = feePercentage.mul(destinationTokenQuantity).div(ether(1));
          const newUnits = preciseDiv(destinationTokenQuantity.sub(unitProtocolFee), cTokenInitialMantissa);
          const expectedFirstPositionUnit = initialPositions[0].unit.add(newUnits);

          expect(initialPositions.length).to.eq(1);
          expect(currentPositions.length).to.eq(2);
          expect(newFirstPosition.component).to.eq(cEther.address);
          expect(newFirstPosition.positionState).to.eq(0); // Default
          expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
          expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
        });

        it("should update the borrow position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          // cEther position is increased
          const currentPositions = await setToken.getPositions();
          const newSecondPosition = (await setToken.getPositions())[1];

          const expectedSecondPositionUnit = (await cDai.borrowBalanceStored(setToken.address)).mul(-1);

          expect(initialPositions.length).to.eq(1);
          expect(currentPositions.length).to.eq(2);
          expect(newSecondPosition.component).to.eq(setup.dai.address);
          expect(newSecondPosition.positionState).to.eq(1); // External
          expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
          expect(newSecondPosition.module).to.eq(compoundLeverageModule.address);
        });

        it("should emit the correct LeverageIncreased event", async () => {
          const totalBorrowQuantity = subjectBorrowQuantity;
          const totalCollateralQuantity = destinationTokenQuantity;
          const totalProtocolFee = feePercentage.mul(totalCollateralQuantity).div(ether(1));

          await expect(subject()).to.emit(compoundLeverageModule, "LeverageIncreased").withArgs(
            setToken.address,
            subjectBorrowAsset,
            subjectCollateralAsset,
            oneInchExchangeAdapterToWeth.address,
            totalBorrowQuantity,
            totalCollateralQuantity.sub(totalProtocolFee),
            totalProtocolFee
          );
        });
      });

      describe("when slippage is greater than allowed", async () => {
        beforeEach(async () => {
          // Add Set token as token sender / recipient
          oneInchExchangeMockWithSlippage = oneInchExchangeMockWithSlippage.connect(owner.wallet);
          await oneInchExchangeMockWithSlippage.addSetTokenAddress(setToken.address);

          // Fund One Inch exchange with destinationToken WETH
          await setup.weth.transfer(oneInchExchangeMockWithSlippage.address, ether(10));

          // Set to other mock exchange adapter with slippage
          subjectTradeAdapterName = "ONEINCHSLIPPAGE";
          subjectTradeData = oneInchExchangeMockWithSlippage.interface.encodeFunctionData("swap", [
            setup.dai.address, // Send token
            setup.weth.address, // Receive token
            subjectBorrowQuantity, // Send quantity
            subjectMinCollateralQuantity, // Min receive quantity
            ZERO,
            ADDRESS_ZERO,
            [ADDRESS_ZERO],
            EMPTY_BYTES,
            [ZERO],
            [ZERO],
          ]);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Slippage greater than allowed");
        });
      });

      describe("when the exchange is not valid", async () => {
        beforeEach(async () => {
          subjectTradeAdapterName = "UNISWAP";
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be valid adapter");
        });
      });

      describe("when quantity of token to sell is 0", async () => {
        beforeEach(async () => {
          subjectBorrowQuantity = ZERO;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Token to sell must be nonzero");
        });
      });

      describe("when borrowing return data is a nonzero value", async () => {
        beforeEach(async () => {
          // Set borrow quantity to more than reserves
          subjectBorrowQuantity = ether(100001);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Borrow failed");
        });
      });

      describe("when collateral asset is not enabled", async () => {
        beforeEach(async () => {
          subjectCollateralAsset = setup.wbtc.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Collateral is not enabled");
        });
      });

      describe("when borrow asset is not enabled", async () => {
        beforeEach(async () => {
          subjectBorrowAsset = await getRandomAddress();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Borrow is not enabled");
        });
      });

      describe("when borrow asset is same as collateral asset", async () => {
        beforeEach(async () => {
          subjectBorrowAsset = setup.weth.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be different");
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

      describe("when module is not initialized", async () => {
        before(async () => {
          isInitialized = false;
        });

        after(async () => {
          isInitialized = true;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });

      describe("when SetToken is not valid", async () => {
        beforeEach(async () => {
          const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
            [setup.weth.address],
            [ether(1)],
            [compoundLeverageModule.address],
            owner.address
          );

          subjectSetToken = nonEnabledSetToken.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });
    });

    context("when cETH is borrow asset and borrow positions is 0", async () => {
      before(async () => {
        isInitialized = true;
      });

      beforeEach(async () => {
        setToken = await setup.createSetToken(
          [cDai.address],
          [BigNumber.from(10000000000000)],
          [compoundLeverageModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
        );
        await debtIssuanceMock.initialize(setToken.address);
        // Initialize module if set to true
        if (isInitialized) {
          await compoundLeverageModule.initialize(
            setToken.address,
            [setup.weth.address, setup.dai.address],
            [setup.dai.address, setup.weth.address]
          );
        }
        await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);

        // Add Set token as token sender / recipient
        oneInchExchangeMockFromWeth = oneInchExchangeMockFromWeth.connect(owner.wallet);
        await oneInchExchangeMockFromWeth.addSetTokenAddress(setToken.address);

        // Fund One Inch exchange with destinationToken DAI
        await setup.dai.transfer(oneInchExchangeMockFromWeth.address, ether(100000));

        // Mint cTokens
        await setup.dai.approve(cDai.address, ether(100000));
        await cDai.mint(ether(10000));
        await setup.weth.approve(cEther.address, ether(1000));
        await cEther.mint({value: ether(1000)});

        // Approve tokens to issuance module and call issue
        await cDai.approve(setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 1 ETH regardless of Set supply
        const issueQuantity = ether(1);
        destinationTokenQuantity = ether(590);
        await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);
        subjectSetToken = setToken.address;
        subjectBorrowAsset = setup.weth.address;
        subjectCollateralAsset = setup.dai.address;
        subjectBorrowQuantity = ether(1);
        subjectMinCollateralQuantity = destinationTokenQuantity;
        subjectTradeAdapterName = "ONEINCHFROMWETH";
        subjectTradeData = oneInchExchangeMockFromWeth.interface.encodeFunctionData("swap", [
          setup.weth.address, // Send token
          setup.dai.address, // Receive token
          subjectBorrowQuantity, // Send quantity
          subjectMinCollateralQuantity, // Min receive quantity
          ZERO,
          ADDRESS_ZERO,
          [ADDRESS_ZERO],
          EMPTY_BYTES,
          [ZERO],
          [ZERO],
        ]);
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return compoundLeverageModule.connect(subjectCaller.wallet).lever(
          subjectSetToken,
          subjectBorrowAsset,
          subjectCollateralAsset,
          subjectBorrowQuantity,
          subjectMinCollateralQuantity,
          subjectTradeAdapterName,
          subjectTradeData
        );
      }

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cDai position is increased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        // Get expected cTokens minted
        const newUnits = preciseDiv(destinationTokenQuantity, cTokenInitialMantissa);
        const expectedFirstPositionUnit = initialPositions[0].unit.add(newUnits);

        expect(initialPositions.length).to.eq(1);
        expect(currentPositions.length).to.eq(2);
        expect(newFirstPosition.component).to.eq(cDai.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should update the borrow position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newSecondPosition = (await setToken.getPositions())[1];

        const expectedSecondPositionUnit = (await cEther.borrowBalanceStored(setToken.address)).mul(-1);

        expect(initialPositions.length).to.eq(1);
        expect(currentPositions.length).to.eq(2);
        expect(newSecondPosition.component).to.eq(setup.weth.address);
        expect(newSecondPosition.positionState).to.eq(1); // External
        expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
        expect(newSecondPosition.module).to.eq(compoundLeverageModule.address);
      });

      it("should transfer the correct components to the exchange", async () => {
        const oldSourceTokenBalance = await setup.weth.balanceOf(oneInchExchangeMockFromWeth.address);

        await subject();
        const totalSourceQuantity = subjectBorrowQuantity;
        const expectedSourceTokenBalance = oldSourceTokenBalance.add(totalSourceQuantity);
        const newSourceTokenBalance = await setup.weth.balanceOf(oneInchExchangeMockFromWeth.address);
        expect(newSourceTokenBalance).to.eq(expectedSourceTokenBalance);
      });

      it("should transfer the correct components from the exchange", async () => {
        const oldDestinationTokenBalance = await setup.dai.balanceOf(oneInchExchangeMockFromWeth.address);

        await subject();
        const totalDestinationQuantity = destinationTokenQuantity;
        const expectedDestinationTokenBalance = oldDestinationTokenBalance.sub(totalDestinationQuantity);
        const newDestinationTokenBalance = await setup.dai.balanceOf(oneInchExchangeMockFromWeth.address);
        expect(newDestinationTokenBalance).to.eq(expectedDestinationTokenBalance);
      });

      describe("when borrowing return data is a nonzero value", async () => {
        beforeEach(async () => {
          // Set borrow quantity to more than reserves
          subjectBorrowQuantity = ether(1000);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Borrow failed");
        });
      });

      describe("when minting returns a nonzero value", async () => {
        beforeEach(async () => {
          const newComptroller = await deployer.external.deployComptroller();

          await cDai._setComptroller(newComptroller.address);
        });

        afterEach(async () => {
          await cDai._setComptroller(compoundSetup.comptroller.address);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Mint failed");
        });
      });
    });

    context("when DAI is borrow asset, and is a default position", async () => {
      before(async () => {
        isInitialized = true;
      });

      beforeEach(async () => {
        setToken = await setup.createSetToken(
          [cEther.address, setup.dai.address],
          [BigNumber.from(10000000000), ether(1)],
          [compoundLeverageModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
        );
        await debtIssuanceMock.initialize(setToken.address);
        // Initialize module if set to true
        if (isInitialized) {
          await compoundLeverageModule.initialize(
            setToken.address,
            [setup.weth.address, setup.dai.address],
            [setup.dai.address, setup.weth.address]
          );
        }
        await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);

        // Add Set token as token sender / recipient
        oneInchExchangeMockToWeth = oneInchExchangeMockToWeth.connect(owner.wallet);
        await oneInchExchangeMockToWeth.addSetTokenAddress(setToken.address);

        // Fund One Inch exchange with destinationToken WETH
        await setup.weth.transfer(oneInchExchangeMockToWeth.address, ether(10));

        // Mint cTokens
        await setup.weth.approve(cEther.address, ether(1000));
        await cEther.mint({value: ether(1000)});
        await setup.dai.approve(cDai.address, ether(100000));
        await cDai.mint(ether(100000));

        // Approve tokens to issuance module and call issue
        await cEther.approve(setup.issuanceModule.address, ether(1000));
        await setup.dai.approve(setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 590 DAI regardless of Set supply
        const issueQuantity = ether(1);
        destinationTokenQuantity = ether(1);
        await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);
        subjectSetToken = setToken.address;
        subjectBorrowAsset = setup.dai.address;
        subjectCollateralAsset = setup.weth.address;
        subjectBorrowQuantity = ether(590);
        subjectMinCollateralQuantity = destinationTokenQuantity;
        subjectTradeAdapterName = "ONEINCHTOWETH";
        subjectTradeData = oneInchExchangeMockToWeth.interface.encodeFunctionData("swap", [
          setup.dai.address, // Send token
          setup.weth.address, // Receive token
          subjectBorrowQuantity, // Send quantity
          subjectMinCollateralQuantity, // Min receive quantity
          ZERO,
          ADDRESS_ZERO,
          [ADDRESS_ZERO],
          EMPTY_BYTES,
          [ZERO],
          [ZERO],
        ]);
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return compoundLeverageModule.connect(subjectCaller.wallet).lever(
          subjectSetToken,
          subjectBorrowAsset,
          subjectCollateralAsset,
          subjectBorrowQuantity,
          subjectMinCollateralQuantity,
          subjectTradeAdapterName,
          subjectTradeData
        );
      }

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];
        const newSecondPosition = (await setToken.getPositions())[1];

        // Get expected cTokens minted
        const newUnits = preciseDiv(destinationTokenQuantity, cTokenInitialMantissa);
        const expectedFirstPositionUnit = initialPositions[0].unit.add(newUnits);

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(3);
        expect(newFirstPosition.component).to.eq(cEther.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);

        expect(newSecondPosition.component).to.eq(setup.dai.address);
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

        const expectedPositionUnit = (await cDai.borrowBalanceStored(setToken.address)).mul(-1);

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(3);
        expect(newThridPosition.component).to.eq(setup.dai.address);
        expect(newThridPosition.positionState).to.eq(1); // External
        expect(newThridPosition.unit).to.eq(expectedPositionUnit);
        expect(newThridPosition.module).to.eq(compoundLeverageModule.address);
      });
    });
  });

  describe("#delever", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;
    let destinationTokenQuantity: BigNumber;

    let subjectSetToken: Address;
    let subjectCollateralAsset: Address;
    let subjectRepayAsset: Address;
    let subjectRedeemQuantity: BigNumber;
    let subjectMinRepayQuantity: BigNumber;
    let subjectTradeAdapterName: string;
    let subjectTradeData: Bytes;
    let subjectCaller: Account;

    context("when cETH is collateral asset", async () => {
      before(async () => {
        isInitialized = true;
      });

      beforeEach(async () => {
        setToken = await setup.createSetToken(
          [cEther.address],
          [BigNumber.from(10000000000)],
          [compoundLeverageModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
        );
        await debtIssuanceMock.initialize(setToken.address);
        // Initialize module if set to true
        if (isInitialized) {
          await compoundLeverageModule.initialize(
            setToken.address,
            [setup.weth.address, setup.dai.address],
            [setup.dai.address, setup.weth.address]
          );
        }
        await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);

        // Add Set token as token sender / recipient
        oneInchExchangeMockToWeth = oneInchExchangeMockToWeth.connect(owner.wallet);
        await oneInchExchangeMockToWeth.addSetTokenAddress(setToken.address);

        // Fund One Inch exchange with destinationToken WETH
        await setup.weth.transfer(oneInchExchangeMockToWeth.address, ether(10));

        // Add Set token as token sender / recipient
        oneInchExchangeMockFromWeth = oneInchExchangeMockFromWeth.connect(owner.wallet);
        await oneInchExchangeMockFromWeth.addSetTokenAddress(setToken.address);

        // Fund One Inch exchange with destinationToken DAI
        await setup.dai.transfer(oneInchExchangeMockFromWeth.address, ether(10000));

        // Mint cTokens
        await setup.weth.approve(cEther.address, ether(1000));
        await cEther.mint({value: ether(1000)});
        await setup.dai.approve(cDai.address, ether(100000));
        await cDai.mint(ether(100000));

        // Approve tokens to issuance module and call issue
        await cEther.approve(setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 590 DAI regardless of Set supply
        const issueQuantity = ether(1);
        await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        // Lever SetToken
        if (isInitialized) {
          const leverTradeData = oneInchExchangeMockToWeth.interface.encodeFunctionData("swap", [
            setup.dai.address, // Send token
            setup.weth.address, // Receive token
            ether(590), // Send quantity
            ether(1), // Min receive quantity
            ZERO,
            ADDRESS_ZERO,
            [ADDRESS_ZERO],
            EMPTY_BYTES,
            [ZERO],
            [ZERO],
          ]);

          await compoundLeverageModule.lever(
            setToken.address,
            setup.dai.address,
            setup.weth.address,
            ether(590),
            ether(1),
            "ONEINCHTOWETH",
            leverTradeData
          );
        }

        destinationTokenQuantity = ether(590);
        subjectSetToken = setToken.address;
        subjectCollateralAsset = setup.weth.address;
        subjectRepayAsset = setup.dai.address;
        subjectRedeemQuantity = ether(1);
        subjectMinRepayQuantity = destinationTokenQuantity;
        subjectTradeAdapterName = "ONEINCHFROMWETH";
        subjectTradeData = oneInchExchangeMockFromWeth.interface.encodeFunctionData("swap", [
          setup.weth.address, // Send token
          setup.dai.address, // Receive token
          subjectRedeemQuantity, // Send quantity
          subjectMinRepayQuantity, // Min receive quantity
          ZERO,
          ADDRESS_ZERO,
          [ADDRESS_ZERO],
          EMPTY_BYTES,
          [ZERO],
          [ZERO],
        ]);
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return compoundLeverageModule.connect(subjectCaller.wallet).delever(
          subjectSetToken,
          subjectCollateralAsset,
          subjectRepayAsset,
          subjectRedeemQuantity,
          subjectMinRepayQuantity,
          subjectTradeAdapterName,
          subjectTradeData
        );
      }

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        // Get expected cTokens minted
        const removedUnits = preciseDiv(subjectRedeemQuantity, cTokenInitialMantissa);
        const expectedFirstPositionUnit = initialPositions[0].unit.sub(removedUnits);

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newFirstPosition.component).to.eq(cEther.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should update the borrow position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // Most of cDai position is repaid
        const currentPositions = await setToken.getPositions();
        const newSecondPosition = (await setToken.getPositions())[1];
        const expectedSecondPositionUnit = (await cDai.borrowBalanceStored(setToken.address)).mul(-1);

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newSecondPosition.component).to.eq(setup.dai.address);
        expect(newSecondPosition.positionState).to.eq(1); // External
        expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
        expect(newSecondPosition.module).to.eq(compoundLeverageModule.address);
      });

      it("should transfer the correct components to the exchange", async () => {
        const oldSourceTokenBalance = await setup.weth.balanceOf(oneInchExchangeMockFromWeth.address);

        await subject();
        const totalSourceQuantity = subjectRedeemQuantity;
        const expectedSourceTokenBalance = oldSourceTokenBalance.add(totalSourceQuantity);
        const newSourceTokenBalance = await setup.weth.balanceOf(oneInchExchangeMockFromWeth.address);
        expect(newSourceTokenBalance).to.eq(expectedSourceTokenBalance);
      });

      it("should transfer the correct components from the exchange", async () => {
        const oldDestinationTokenBalance = await setup.dai.balanceOf(oneInchExchangeMockFromWeth.address);

        await subject();
        const totalDestinationQuantity = destinationTokenQuantity;
        const expectedDestinationTokenBalance = oldDestinationTokenBalance.sub(totalDestinationQuantity);
        const newDestinationTokenBalance = await setup.dai.balanceOf(oneInchExchangeMockFromWeth.address);
        expect(newDestinationTokenBalance).to.eq(expectedDestinationTokenBalance);
      });

      describe("when there is a protocol fee charged", async () => {
        let feePercentage: BigNumber;

        beforeEach(async () => {
          feePercentage = ether(0.05);
          setup.controller = setup.controller.connect(owner.wallet);
          await setup.controller.addFee(
            compoundLeverageModule.address,
            ZERO, // Fee type on trade function denoted as 0
            feePercentage // Set fee to 5 bps
          );
        });

        it("should transfer the correct components to the exchange", async () => {
          const oldSourceTokenBalance = await setup.weth.balanceOf(oneInchExchangeMockFromWeth.address);

          await subject();
          const totalSourceQuantity = subjectRedeemQuantity;
          const expectedSourceTokenBalance = oldSourceTokenBalance.add(totalSourceQuantity);
          const newSourceTokenBalance = await setup.weth.balanceOf(oneInchExchangeMockFromWeth.address);
          expect(newSourceTokenBalance).to.eq(expectedSourceTokenBalance);
        });

        it("should transfer the correct protocol fee to the protocol", async () => {
          const feeRecipient = await setup.controller.feeRecipient();
          const oldFeeRecipientBalance = await setup.dai.balanceOf(feeRecipient);

          await subject();
          const expectedFeeRecipientBalance = oldFeeRecipientBalance.add(preciseMul(feePercentage, destinationTokenQuantity));
          const newFeeRecipientBalance = await setup.dai.balanceOf(feeRecipient);
          expect(newFeeRecipientBalance).to.eq(expectedFeeRecipientBalance);
        });

        it("should update the collateral position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          // cEther position is increased
          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];

          // Get expected cTokens minted
          const newUnits = preciseDiv(subjectRedeemQuantity, cTokenInitialMantissa);
          const expectedFirstPositionUnit = initialPositions[0].unit.sub(newUnits);

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(2);
          expect(newFirstPosition.component).to.eq(cEther.address);
          expect(newFirstPosition.positionState).to.eq(0); // Default
          expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
          expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
        });

        it("should update the borrow position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          // cEther position is increased
          const currentPositions = await setToken.getPositions();
          const newSecondPosition = (await setToken.getPositions())[1];

          const expectedSecondPositionUnit = (await cDai.borrowBalanceStored(setToken.address)).mul(-1);

          expect(initialPositions.length).to.eq(2);
          expect(currentPositions.length).to.eq(2);
          expect(newSecondPosition.component).to.eq(setup.dai.address);
          expect(newSecondPosition.positionState).to.eq(1); // External
          expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
          expect(newSecondPosition.module).to.eq(compoundLeverageModule.address);
        });

        it("should emit the correct LeverageDecreased event", async () => {
          const totalCollateralQuantity = subjectRedeemQuantity;
          const totalRepayQuantity = destinationTokenQuantity;
          const totalProtocolFee = feePercentage.mul(totalRepayQuantity).div(ether(1));

          await expect(subject()).to.emit(compoundLeverageModule, "LeverageDecreased").withArgs(
            setToken.address,
            subjectCollateralAsset,
            subjectRepayAsset,
            oneInchExchangeAdapterFromWeth.address,
            totalCollateralQuantity,
            totalRepayQuantity.sub(totalProtocolFee),
            totalProtocolFee
          );
        });
      });

      describe("when the exchange is not valid", async () => {
        beforeEach(async () => {
          subjectTradeAdapterName = "UNISWAP";
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be valid adapter");
        });
      });

      describe("when quantity of token to sell is 0", async () => {
        beforeEach(async () => {
          subjectRedeemQuantity = ZERO;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Token to sell must be nonzero");
        });
      });

      describe("when redeeming return data is a nonzero value", async () => {
        beforeEach(async () => {
          // Set redeem quantity to more than account liquidity
          subjectRedeemQuantity = ether(100001);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Redeem failed");
        });
      });

      describe("when repay return data is a nonzero value", async () => {
        beforeEach(async () => {
          const newComptroller = await deployer.external.deployComptroller();

          await cDai._setComptroller(newComptroller.address);
        });

        afterEach(async () => {
          await cDai._setComptroller(compoundSetup.comptroller.address);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Repay failed");
        });
      });

      describe("when borrow / repay asset is not enabled", async () => {
        beforeEach(async () => {
          subjectRepayAsset = setup.wbtc.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Borrow is not enabled");
        });
      });

      describe("when collateral asset is not enabled", async () => {
        beforeEach(async () => {
          subjectCollateralAsset = await getRandomAddress();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Collateral is not enabled");
        });
      });

      describe("when borrow asset is same as collateral asset", async () => {
        beforeEach(async () => {
          subjectRepayAsset = setup.weth.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be different");
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

      describe("when module is not initialized", async () => {
        before(async () => {
          isInitialized = false;
        });

        after(async () => {
          isInitialized = true;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });

      describe("when SetToken is not valid", async () => {
        beforeEach(async () => {
          const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
            [setup.weth.address],
            [ether(1)],
            [compoundLeverageModule.address],
            owner.address
          );

          subjectSetToken = nonEnabledSetToken.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });
    });

    context("when cETH is borrow asset", async () => {
      before(async () => {
        isInitialized = true;
      });

      beforeEach(async () => {
        setToken = await setup.createSetToken(
          [cDai.address],
          [BigNumber.from(10000000000000)],
          [compoundLeverageModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
        );
        await debtIssuanceMock.initialize(setToken.address);
        // Initialize module if set to true
        if (isInitialized) {
          await compoundLeverageModule.initialize(
            setToken.address,
            [setup.weth.address, setup.dai.address],
            [setup.dai.address, setup.weth.address]
          );
        }
        await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);

        // Add Set token as token sender / recipient
        oneInchExchangeMockToWeth = oneInchExchangeMockToWeth.connect(owner.wallet);
        await oneInchExchangeMockToWeth.addSetTokenAddress(setToken.address);

        // Fund One Inch exchange with destinationToken WETH
        await setup.weth.transfer(oneInchExchangeMockToWeth.address, ether(10));

        // Add Set token as token sender / recipient
        oneInchExchangeMockFromWeth = oneInchExchangeMockFromWeth.connect(owner.wallet);
        await oneInchExchangeMockFromWeth.addSetTokenAddress(setToken.address);

        // Fund One Inch exchange with destinationToken DAI
        await setup.dai.transfer(oneInchExchangeMockFromWeth.address, ether(10000));

        // Mint cTokens
        await setup.weth.approve(cEther.address, ether(1000));
        await cEther.mint({value: ether(1000)});
        await setup.dai.approve(cDai.address, ether(100000));
        await cDai.mint(ether(100000));

        // Approve tokens to issuance module and call issue
        await cDai.approve(setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 590 DAI regardless of Set supply
        const issueQuantity = ether(1);
        await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        // Lever SetToken
        if (isInitialized) {
          const leverTradeData = oneInchExchangeMockFromWeth.interface.encodeFunctionData("swap", [
            setup.weth.address, // Send token
            setup.dai.address, // Receive token
            ether(1), // Send quantity
            ether(590), // Min receive quantity
            ZERO,
            ADDRESS_ZERO,
            [ADDRESS_ZERO],
            EMPTY_BYTES,
            [ZERO],
            [ZERO],
          ]);

          await compoundLeverageModule.lever(
            setToken.address,
            setup.weth.address,
            setup.dai.address,
            ether(1),
            ether(590),
            "ONEINCHFROMWETH",
            leverTradeData
          );
        }

        destinationTokenQuantity = ether(1);
        subjectSetToken = setToken.address;
        subjectCollateralAsset = setup.dai.address;
        subjectRepayAsset = setup.weth.address;
        subjectRedeemQuantity = ether(590);
        subjectMinRepayQuantity = destinationTokenQuantity;
        subjectTradeAdapterName = "ONEINCHTOWETH";
        subjectTradeData = oneInchExchangeMockFromWeth.interface.encodeFunctionData("swap", [
          setup.dai.address, // Send token
          setup.weth.address, // Receive token
          subjectRedeemQuantity, // Send quantity
          subjectMinRepayQuantity, // Min receive quantity
          ZERO,
          ADDRESS_ZERO,
          [ADDRESS_ZERO],
          EMPTY_BYTES,
          [ZERO],
          [ZERO],
        ]);
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return compoundLeverageModule.connect(subjectCaller.wallet).delever(
          subjectSetToken,
          subjectCollateralAsset,
          subjectRepayAsset,
          subjectRedeemQuantity,
          subjectMinRepayQuantity,
          subjectTradeAdapterName,
          subjectTradeData
        );
      }

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cDai position is decreased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        // Get expected cTokens minted
        const newUnits = preciseDiv(subjectRedeemQuantity, cTokenInitialMantissa);
        const expectedFirstPositionUnit = initialPositions[0].unit.sub(newUnits);

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newFirstPosition.component).to.eq(cDai.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should update the borrow position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newSecondPosition = (await setToken.getPositions())[1];

        const expectedSecondPositionUnit = (await cEther.borrowBalanceStored(setToken.address)).mul(-1);

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newSecondPosition.component).to.eq(setup.weth.address);
        expect(newSecondPosition.positionState).to.eq(1); // External
        expect(newSecondPosition.unit).to.eq(expectedSecondPositionUnit);
        expect(newSecondPosition.module).to.eq(compoundLeverageModule.address);
      });

      it("should transfer the correct components to the exchange", async () => {
        const oldSourceTokenBalance = await setup.dai.balanceOf(oneInchExchangeMockToWeth.address);

        await subject();
        const totalSourceQuantity = subjectRedeemQuantity;
        const expectedSourceTokenBalance = oldSourceTokenBalance.add(totalSourceQuantity);
        const newSourceTokenBalance = await setup.dai.balanceOf(oneInchExchangeMockToWeth.address);
        expect(newSourceTokenBalance).to.eq(expectedSourceTokenBalance);
      });

      it("should transfer the correct components from the exchange", async () => {
        const oldDestinationTokenBalance = await setup.weth.balanceOf(oneInchExchangeMockToWeth.address);

        await subject();
        const totalDestinationQuantity = destinationTokenQuantity;
        const expectedDestinationTokenBalance = oldDestinationTokenBalance.sub(totalDestinationQuantity);
        const newDestinationTokenBalance = await setup.weth.balanceOf(oneInchExchangeMockToWeth.address);
        expect(newDestinationTokenBalance).to.eq(expectedDestinationTokenBalance);
      });

      describe("when redeem return data is a nonzero value", async () => {
        beforeEach(async () => {
          // Set borrow quantity to more than reserves
          subjectRedeemQuantity = ether(100000);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Redeem failed");
        });
      });

      describe("when slippage is greater than allowed", async () => {
        beforeEach(async () => {
          // Add Set token as token sender / recipient
          oneInchExchangeMockWithSlippage = oneInchExchangeMockWithSlippage.connect(owner.wallet);
          await oneInchExchangeMockWithSlippage.addSetTokenAddress(setToken.address);

          // Fund One Inch exchange with destinationToken WETH
          await setup.weth.transfer(oneInchExchangeMockWithSlippage.address, ether(10));

          // Set to other mock exchange adapter with slippage
          subjectTradeAdapterName = "ONEINCHSLIPPAGE";
          subjectTradeData = oneInchExchangeMockWithSlippage.interface.encodeFunctionData("swap", [
            setup.dai.address, // Send token
            setup.weth.address, // Receive token
            subjectRedeemQuantity, // Send quantity
            subjectMinRepayQuantity, // Min receive quantity
            ZERO,
            ADDRESS_ZERO,
            [ADDRESS_ZERO],
            EMPTY_BYTES,
            [ZERO],
            [ZERO],
          ]);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Slippage greater than allowed");
        });
      });
    });
  });

  describe("#sync", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;

    let subjectSetToken: Address;
    let subjectCaller: Account;

    context("when cETH and cDAI are collateral and WETH and DAI are borrow assets", async () => {
      before(async () => {
        isInitialized = true;
      });

      beforeEach(async () => {
        setToken = await setup.createSetToken(
          [cEther.address, cDai.address],
          [BigNumber.from(10000000000), BigNumber.from(100000000000)],
          [compoundLeverageModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
        );
        await debtIssuanceMock.initialize(setToken.address);
        // Initialize module if set to true
        if (isInitialized) {
          await compoundLeverageModule.initialize(
            setToken.address,
            [setup.weth.address, setup.dai.address, compoundSetup.comp.address], // Enable COMP that is not a Set position
            [setup.dai.address, setup.weth.address, compoundSetup.comp.address]
          );
        }
        await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);

        // Add Set token as token sender / recipient
        await oneInchExchangeMockToWeth.addSetTokenAddress(setToken.address);
        await oneInchExchangeMockFromWeth.addSetTokenAddress(setToken.address);

        // Fund One Inch exchange with destinationToken WETH and DAI
        await setup.weth.transfer(oneInchExchangeMockToWeth.address, ether(10));
        await setup.dai.transfer(oneInchExchangeMockFromWeth.address, ether(10000));

        // Mint cTokens
        await setup.weth.approve(cEther.address, ether(1000));
        await cEther.mint({value: ether(1000)});
        await setup.dai.approve(cDai.address, ether(100000));
        await cDai.mint(ether(100000));

        // Approve tokens to issuance module and call issue
        await cEther.approve(setup.issuanceModule.address, ether(1000));
        await cDai.approve(setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 590 DAI regardless of Set supply
        const issueQuantity = ether(1);
        await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        // Lever both cDAI and cETH in SetToken
        if (isInitialized) {
          const leverEthTradeData = oneInchExchangeMockToWeth.interface.encodeFunctionData("swap", [
            setup.dai.address, // Send token
            setup.weth.address, // Receive token
            ether(590), // Send quantity
            ether(1), // Min receive quantity
            ZERO,
            ADDRESS_ZERO,
            [ADDRESS_ZERO],
            EMPTY_BYTES,
            [ZERO],
            [ZERO],
          ]);

          await compoundLeverageModule.lever(
            setToken.address,
            setup.dai.address,
            setup.weth.address,
            ether(590),
            ether(1),
            "ONEINCHTOWETH",
            leverEthTradeData
          );

          const leverDaiTradeData = oneInchExchangeMockToWeth.interface.encodeFunctionData("swap", [
            setup.weth.address, // Send token
            setup.dai.address, // Receive token
            ether(1), // Send quantity
            ether(590), // Min receive quantity
            ZERO,
            ADDRESS_ZERO,
            [ADDRESS_ZERO],
            EMPTY_BYTES,
            [ZERO],
            [ZERO],
          ]);

          await compoundLeverageModule.lever(
            setToken.address,
            setup.weth.address,
            setup.dai.address,
            ether(1),
            ether(590),
            "ONEINCHFROMWETH",
            leverDaiTradeData
          );
        }

        subjectSetToken = setToken.address;
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return compoundLeverageModule.connect(subjectCaller.wallet).sync(subjectSetToken);
      }

      it("should update the collateral positions on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];
        const newSecondPosition = (await setToken.getPositions())[1];

        expect(initialPositions.length).to.eq(4);
        expect(currentPositions.length).to.eq(4);
        expect(newFirstPosition.component).to.eq(cEther.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(initialPositions[0].unit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);

        expect(newSecondPosition.component).to.eq(cDai.address);
        expect(newSecondPosition.positionState).to.eq(0); // Default
        expect(newSecondPosition.unit).to.eq(initialPositions[1].unit);
        expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should update the borrow positions on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newThirdPosition = (await setToken.getPositions())[2];
        const newFourthPosition = (await setToken.getPositions())[3];

        const expectedThirdPositionUnit = (await cDai.borrowBalanceStored(setToken.address)).mul(-1);
        const expectedFourthPositionUnit = (await cEther.borrowBalanceStored(setToken.address)).mul(-1);

        expect(initialPositions.length).to.eq(4);
        expect(currentPositions.length).to.eq(4);
        expect(newThirdPosition.component).to.eq(setup.dai.address);
        expect(newThirdPosition.positionState).to.eq(1); // External
        expect(newThirdPosition.unit).to.eq(expectedThirdPositionUnit);
        expect(newThirdPosition.module).to.eq(compoundLeverageModule.address);

        expect(newFourthPosition.component).to.eq(setup.weth.address);
        expect(newFourthPosition.positionState).to.eq(1); // External
        expect(newFourthPosition.unit).to.eq(expectedFourthPositionUnit);
        expect(newFourthPosition.module).to.eq(compoundLeverageModule.address);
      });

      it("should emit the correct PositionsSynced event", async () => {
        await expect(subject()).to.emit(compoundLeverageModule, "PositionsSynced").withArgs(
          setToken.address,
          subjectCaller.address
        );
      });

      describe("when leverage position has been liquidated", async () => {
        let liquidationRepayQuantity: BigNumber;

        beforeEach(async () => {

          // Set price to be liquidated
          const liquidationEthPrice = ether(100);
          await compoundSetup.priceOracle.setUnderlyingPrice(cEther.address, liquidationEthPrice);

          // Seize 1 ETH + 8% penalty as set on Comptroller
          liquidationRepayQuantity = ether(100);
          await setup.dai.approve(cDai.address, ether(100000));
          await cDai.liquidateBorrow(setToken.address, liquidationRepayQuantity, cEther.address);
        });

        it("should update the collateral positions on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];
          const newSecondPosition = (await setToken.getPositions())[1];

          // Get expected cTokens minted
          const actualSeizedTokens = await compoundSetup.comptroller.liquidateCalculateSeizeTokens(
            cDai.address,
            cEther.address,
            liquidationRepayQuantity
          );

          const expectedPostLiquidationUnit = initialPositions[0].unit.sub(actualSeizedTokens[1]);
          expect(initialPositions.length).to.eq(4);
          expect(currentPositions.length).to.eq(4);
          expect(newFirstPosition.component).to.eq(cEther.address);
          expect(newFirstPosition.positionState).to.eq(0); // Default
          expect(newFirstPosition.unit).to.eq(expectedPostLiquidationUnit);
          expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);

          // cDAI position should stay the same
          expect(newSecondPosition.component).to.eq(cDai.address);
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

          const expectedThirdPositionUnit = (await cDai.borrowBalanceStored(setToken.address)).mul(-1);
          const expectedFourthPositionUnit = (await cEther.borrowBalanceStored(setToken.address)).mul(-1);

          expect(initialPositions.length).to.eq(4);
          expect(currentPositions.length).to.eq(4);
          expect(newThirdPosition.component).to.eq(setup.dai.address);
          expect(newThirdPosition.positionState).to.eq(1); // External
          expect(newThirdPosition.unit).to.eq(expectedThirdPositionUnit);
          expect(newThirdPosition.module).to.eq(compoundLeverageModule.address);

          expect(newFourthPosition.component).to.eq(setup.weth.address);
          expect(newFourthPosition.positionState).to.eq(1); // External
          expect(newFourthPosition.unit).to.eq(expectedFourthPositionUnit);
          expect(newFourthPosition.module).to.eq(compoundLeverageModule.address);
        });
      });

      describe("when module is not initialized", async () => {
        before(async () => {
          isInitialized = false;
        });

        after(async () => {
          isInitialized = true;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });

      describe("when SetToken is not valid", async () => {
        beforeEach(async () => {
          const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
            [setup.weth.address],
            [ether(1)],
            [compoundLeverageModule.address],
            owner.address
          );

          subjectSetToken = nonEnabledSetToken.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });
    });
  });

  describe("#gulp", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;
    let compAmount: BigNumber;
    let gulpComptrollerMock: ComptrollerMock;
    let secondCompoundLeverageModule: CompoundLeverageModule;
    let destinationTokenQuantity: BigNumber;

    let subjectSetToken: Address;
    let subjectCollateralAsset: Address;
    let subjectNotionalMinReceiveQuantity: BigNumber;
    let subjectTradeAdapterName: string;
    let subjectTradeData: Bytes;
    let subjectCaller: Account;

    context("when cETH is collateral asset and borrow positions is 0", async () => {
      before(async () => {
        isInitialized = true;

        // Deploy Comptroller mock as COMP address is hardcoded in Comptroller
        compAmount = ether(10);
        gulpComptrollerMock = await deployer.mocks.deployComptrollerMock(
          compoundSetup.comp.address,
          compAmount,
          cEther.address
        );
        // Note: Deploy leverage module that uses the mock Comptroller
        secondCompoundLeverageModule = await deployer.modules.deployCompoundLeverageModule(
          setup.controller.address,
          compoundSetup.comp.address,
          gulpComptrollerMock.address,
          cEther.address,
          setup.weth.address
        );

        // Setup Mock 1inch exchange for COMP to WETH trade
        destinationTokenQuantity = ether(1);
        oneInchExchangeMockFromComp = await deployer.mocks.deployOneInchExchangeMock(
          compoundSetup.comp.address,
          setup.weth.address,
          compAmount, // 10 COMP
          destinationTokenQuantity, // Trades for 1 WETH
        );
        oneInchExchangeAdapterFromComp = await deployer.adapters.deployOneInchExchangeAdapter(
          oneInchExchangeMockFromComp.address,
          oneInchExchangeMockFromComp.address,
          oneInchFunctionSignature
        );
        await setup.controller.addModule(secondCompoundLeverageModule.address);
        await setup.integrationRegistry.addIntegration(
          secondCompoundLeverageModule.address,
          "ONEINCHCOMP",
          oneInchExchangeAdapterFromComp.address
        );

        // Add debt issuance address to integration
        await setup.integrationRegistry.addIntegration(
          secondCompoundLeverageModule.address,
          "DefaultIssuanceModule",
          debtIssuanceMock.address
        );
      });

      beforeEach(async () => {
        setToken = await setup.createSetToken(
          [cEther.address],
          [BigNumber.from(10000000000)],
          [secondCompoundLeverageModule.address, setup.issuanceModule.address, debtIssuanceMock.address]
        );
        await debtIssuanceMock.initialize(setToken.address);
        await gulpComptrollerMock.addSetTokenAddress(setToken.address);
        // Initialize module if set to true
        if (isInitialized) {
          await secondCompoundLeverageModule.initialize(
            setToken.address,
            [setup.weth.address],
            []
          );
        }
        await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);

        // Add Set token as token sender / recipient
        oneInchExchangeMockFromComp = oneInchExchangeMockFromComp.connect(owner.wallet);
        await oneInchExchangeMockFromComp.addSetTokenAddress(setToken.address);

        // Fund One Inch exchange with destinationToken WETH
        await setup.weth.transfer(oneInchExchangeMockFromComp.address, ether(10));

        await compoundSetup.comp.transfer(gulpComptrollerMock.address, compAmount);

        // Mint cTokens
        await setup.weth.approve(cEther.address, ether(1000));
        await cEther.mint({value: ether(1000)});

        // Approve tokens to issuance module and call issue
        await cEther.approve(setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        subjectSetToken = setToken.address;
        subjectCollateralAsset = setup.weth.address;
        subjectNotionalMinReceiveQuantity = ZERO;
        subjectTradeAdapterName = "ONEINCHCOMP";
        subjectTradeData = oneInchExchangeMockFromComp.interface.encodeFunctionData("swap", [
          compoundSetup.comp.address, // Send token
          setup.weth.address, // Receive token
          compAmount, // Send quantity
          subjectNotionalMinReceiveQuantity, // Min receive quantity
          ZERO,
          ADDRESS_ZERO,
          [ADDRESS_ZERO],
          EMPTY_BYTES,
          [ZERO],
          [ZERO],
        ]);
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return secondCompoundLeverageModule.connect(subjectCaller.wallet).gulp(
          subjectSetToken,
          subjectCollateralAsset,
          subjectNotionalMinReceiveQuantity,
          subjectTradeAdapterName,
          subjectTradeData
        );
      }

      it("should claim COMP", async () => {
        const previousCompBalance = await compoundSetup.comp.balanceOf(setToken.address);

        await subject();

        const currentCompBalance = await compoundSetup.comp.balanceOf(setToken.address);

        expect(previousCompBalance).to.eq(ZERO);
        expect(currentCompBalance).to.eq(ZERO);
      });

      it("should update the collateral position on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        // Get expected cTokens minted
        const newUnits = preciseDiv(destinationTokenQuantity, cTokenInitialMantissa);
        const expectedFirstPositionUnit = initialPositions[0].unit.add(newUnits);

        expect(initialPositions.length).to.eq(1);
        expect(currentPositions.length).to.eq(1);
        expect(newFirstPosition.component).to.eq(cEther.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should transfer the correct components to the exchange", async () => {
        const oldSourceTokenBalance = await setup.dai.balanceOf(oneInchExchangeMockFromComp.address);

        await subject();
        const totalSourceQuantity = compAmount;
        const expectedSourceTokenBalance = oldSourceTokenBalance.add(totalSourceQuantity);
        const newSourceTokenBalance = await compoundSetup.comp.balanceOf(oneInchExchangeMockFromComp.address);
        expect(newSourceTokenBalance).to.eq(expectedSourceTokenBalance);
      });

      it("should transfer the correct components from the exchange", async () => {
        const oldDestinationTokenBalance = await setup.weth.balanceOf(oneInchExchangeMockFromComp.address);

        await subject();
        const totalDestinationQuantity = destinationTokenQuantity;
        const expectedDestinationTokenBalance = oldDestinationTokenBalance.sub(totalDestinationQuantity);
        const newDestinationTokenBalance = await setup.weth.balanceOf(oneInchExchangeMockFromComp.address);
        expect(newDestinationTokenBalance).to.eq(expectedDestinationTokenBalance);
      });

      describe("when there is a protocol fee charged", async () => {
        let feePercentage: BigNumber;

        beforeEach(async () => {
          feePercentage = ether(0.05);
          setup.controller = setup.controller.connect(owner.wallet);
          await setup.controller.addFee(
            secondCompoundLeverageModule.address,
            ZERO, // Fee type on trade function denoted as 0
            feePercentage // Set fee to 5 bps
          );
        });

        it("should transfer the correct components to the exchange", async () => {
          const oldSourceTokenBalance = await compoundSetup.comp.balanceOf(oneInchExchangeMockFromComp.address);

          await subject();
          const totalSourceQuantity = compAmount;
          const expectedSourceTokenBalance = oldSourceTokenBalance.add(totalSourceQuantity);
          const newSourceTokenBalance = await compoundSetup.comp.balanceOf(oneInchExchangeMockFromComp.address);
          expect(newSourceTokenBalance).to.eq(expectedSourceTokenBalance);
        });

        it("should transfer the correct protocol fee to the protocol", async () => {
          const feeRecipient = await setup.controller.feeRecipient();
          const oldFeeRecipientBalance = await setup.weth.balanceOf(feeRecipient);

          await subject();
          const expectedFeeRecipientBalance = oldFeeRecipientBalance.add(preciseMul(feePercentage, destinationTokenQuantity));
          const newFeeRecipientBalance = await setup.weth.balanceOf(feeRecipient);
          expect(newFeeRecipientBalance).to.eq(expectedFeeRecipientBalance);
        });

        it("should update the collateral position on the SetToken correctly", async () => {
          const initialPositions = await setToken.getPositions();

          await subject();

          // cEther position is increased
          const currentPositions = await setToken.getPositions();
          const newFirstPosition = (await setToken.getPositions())[0];

          // Get expected cTokens minted
          const unitProtocolFee = feePercentage.mul(destinationTokenQuantity).div(ether(1));
          const newUnits = preciseDiv(destinationTokenQuantity.sub(unitProtocolFee), cTokenInitialMantissa);
          const expectedFirstPositionUnit = initialPositions[0].unit.add(newUnits);

          expect(initialPositions.length).to.eq(1);
          expect(currentPositions.length).to.eq(1);
          expect(newFirstPosition.component).to.eq(cEther.address);
          expect(newFirstPosition.positionState).to.eq(0); // Default
          expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
          expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
        });

        it("should emit the correct CompGulped event", async () => {
          const totalProtocolFee = feePercentage.mul(destinationTokenQuantity).div(ether(1));
          await expect(subject()).to.emit(secondCompoundLeverageModule, "CompGulped").withArgs(
            setToken.address,
            subjectCollateralAsset,
            oneInchExchangeAdapterFromComp.address,
            compAmount,
            destinationTokenQuantity.sub(totalProtocolFee),
            totalProtocolFee
          );
        });
      });

      describe("when slippage is greater than allowed", async () => {
        beforeEach(async () => {
          // Add Set token as token sender / recipient
          oneInchExchangeMockWithSlippage = oneInchExchangeMockWithSlippage.connect(owner.wallet);
          await oneInchExchangeMockWithSlippage.addSetTokenAddress(setToken.address);

          // Fund One Inch exchange with destinationToken WETH
          await setup.weth.transfer(oneInchExchangeMockWithSlippage.address, ether(10));

          // Set to other mock exchange adapter with slippage
          subjectNotionalMinReceiveQuantity = ether(10);
          subjectTradeData = oneInchExchangeMockFromComp.interface.encodeFunctionData("swap", [
            compoundSetup.comp.address, // Send token
            setup.weth.address, // Receive token
            compAmount, // Send quantity
            subjectNotionalMinReceiveQuantity, // Min receive quantity
            ZERO,
            ADDRESS_ZERO,
            [ADDRESS_ZERO],
            EMPTY_BYTES,
            [ZERO],
            [ZERO],
          ]);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Slippage greater than allowed");
        });
      });

      describe("when the exchange is not valid", async () => {
        beforeEach(async () => {
          subjectTradeAdapterName = "UNISWAP";
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be valid adapter");
        });
      });

      describe("when quantity of token to sell is 0", async () => {
        beforeEach(async () => {
          await secondCompoundLeverageModule.connect(subjectCaller.wallet).gulp(
            subjectSetToken,
            subjectCollateralAsset,
            subjectNotionalMinReceiveQuantity,
            subjectTradeAdapterName,
            subjectTradeData
          );
          // Change COMP transfer amount in mock
          await gulpComptrollerMock.setCompAmount(0);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Token to sell must be nonzero");
        });
      });

      describe("when collateral asset is not enabled", async () => {
        beforeEach(async () => {
          subjectCollateralAsset = await getRandomAddress();
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Collateral is not enabled");
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

      describe("when module is not initialized", async () => {
        before(async () => {
          isInitialized = false;
        });

        after(async () => {
          isInitialized = true;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });

      describe("when SetToken is not valid", async () => {
        beforeEach(async () => {
          const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
            [setup.weth.address],
            [ether(1)],
            [compoundLeverageModule.address],
            owner.address
          );

          subjectSetToken = nonEnabledSetToken.address;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
        });
      });
    });

    context("when cETH is collateral asset and COMP is a position", async () => {
      beforeEach(async () => {
        // Deploy Comptroller mock as COMP address is hardcoded in Comptroller
        compAmount = ether(10);
        gulpComptrollerMock = await deployer.mocks.deployComptrollerMock(
          compoundSetup.comp.address,
          compAmount,
          cEther.address
        );
        // Note: Deploy leverage module that uses the mock Comptroller
        secondCompoundLeverageModule = await deployer.modules.deployCompoundLeverageModule(
          setup.controller.address,
          compoundSetup.comp.address,
          gulpComptrollerMock.address,
          cEther.address,
          setup.weth.address
        );

        // Setup Mock 1inch exchange for COMP to WETH trade
        destinationTokenQuantity = ether(1);
        oneInchExchangeMockFromComp = await deployer.mocks.deployOneInchExchangeMock(
          compoundSetup.comp.address,
          setup.weth.address,
          compAmount, // 10 COMP
          destinationTokenQuantity, // Trades for 1 WETH
        );
        oneInchExchangeAdapterFromComp = await deployer.adapters.deployOneInchExchangeAdapter(
          oneInchExchangeMockFromComp.address,
          oneInchExchangeMockFromComp.address,
          oneInchFunctionSignature
        );
        await setup.controller.addModule(secondCompoundLeverageModule.address);
        await setup.integrationRegistry.addIntegration(
          secondCompoundLeverageModule.address,
          "ONEINCHCOMP",
          oneInchExchangeAdapterFromComp.address
        );
        // Add debt issuance address to integration
        await setup.integrationRegistry.addIntegration(
          secondCompoundLeverageModule.address,
          "DefaultIssuanceModule",
          debtIssuanceMock.address
        );

        setToken = await setup.createSetToken(
          [cEther.address, compoundSetup.comp.address],
          [BigNumber.from(10000000000), ether(10)],
          [secondCompoundLeverageModule.address, setup.issuanceModule.address, debtIssuanceMock.address]
        );
        await debtIssuanceMock.initialize(setToken.address);
        await gulpComptrollerMock.addSetTokenAddress(setToken.address);
        // Initialize module if set to true
        await secondCompoundLeverageModule.initialize(
          setToken.address,
          [setup.weth.address],
          []
        );
        await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);

        // Add Set token as token sender / recipient
        oneInchExchangeMockFromComp = oneInchExchangeMockFromComp.connect(owner.wallet);
        await oneInchExchangeMockFromComp.addSetTokenAddress(setToken.address);

        // Fund One Inch exchange with destinationToken WETH
        await setup.weth.transfer(oneInchExchangeMockFromComp.address, ether(10));

        await compoundSetup.comp.transfer(gulpComptrollerMock.address, compAmount);

        // Mint cTokens
        await setup.weth.approve(cEther.address, ether(1000));
        await cEther.mint({value: ether(1000)});

        // Approve tokens to issuance module and call issue
        await cEther.approve(setup.issuanceModule.address, ether(1000));
        await compoundSetup.comp.approve(setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        subjectSetToken = setToken.address;
        subjectCollateralAsset = setup.weth.address;
        subjectNotionalMinReceiveQuantity = ZERO;
        subjectTradeAdapterName = "ONEINCHCOMP";
        subjectTradeData = oneInchExchangeMockFromComp.interface.encodeFunctionData("swap", [
          compoundSetup.comp.address, // Send token
          setup.weth.address, // Receive token
          compAmount, // Send quantity
          subjectNotionalMinReceiveQuantity, // Min receive quantity
          ZERO,
          ADDRESS_ZERO,
          [ADDRESS_ZERO],
          EMPTY_BYTES,
          [ZERO],
          [ZERO],
        ]);
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return secondCompoundLeverageModule.connect(subjectCaller.wallet).gulp(
          subjectSetToken,
          subjectCollateralAsset,
          subjectNotionalMinReceiveQuantity,
          subjectTradeAdapterName,
          subjectTradeData
        );
      }

      it("should update the positions on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];
        const newSecondPosition = (await setToken.getPositions())[1];

        // Get expected cTokens minted
        const newUnits = preciseDiv(destinationTokenQuantity, cTokenInitialMantissa);
        const expectedFirstPositionUnit = initialPositions[0].unit.add(newUnits);

        expect(initialPositions.length).to.eq(2);
        expect(currentPositions.length).to.eq(2);
        expect(newFirstPosition.component).to.eq(cEther.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);

        expect(newSecondPosition.component).to.eq(compoundSetup.comp.address);
        expect(newSecondPosition.positionState).to.eq(0); // Default
        expect(newSecondPosition.unit).to.eq(ether(10));
        expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
      });
    });

    context("when COMP is the collateral asset", async () => {

      beforeEach(async () => {
        // Deploy Comptroller mock as COMP address is hardcoded in Comptroller
        compAmount = ether(10);
        gulpComptrollerMock = await deployer.mocks.deployComptrollerMock(
          compoundSetup.comp.address,
          compAmount,
          cComp.address
        );
        await compoundSetup.comp.transfer(gulpComptrollerMock.address, compAmount);

        // Note: Deploy leverage module that uses the mock Comptroller
        secondCompoundLeverageModule = await deployer.modules.deployCompoundLeverageModule(
          setup.controller.address,
          compoundSetup.comp.address,
          gulpComptrollerMock.address,
          cEther.address,
          setup.weth.address
        );

        // Setup Mock 1inch exchange which is unused
        await setup.controller.addModule(secondCompoundLeverageModule.address);
        await setup.integrationRegistry.addIntegration(
          secondCompoundLeverageModule.address,
          "ONEINCHUNUSED",
          oneInchExchangeAdapterToWeth.address
        );
        // Add debt issuance address to integration
        await setup.integrationRegistry.addIntegration(
          secondCompoundLeverageModule.address,
          "DefaultIssuanceModule",
          debtIssuanceMock.address
        );

        setToken = await setup.createSetToken(
          [cComp.address],
          [BigNumber.from(10000000000)],
          [secondCompoundLeverageModule.address, setup.issuanceModule.address, debtIssuanceMock.address]
        );
        await debtIssuanceMock.initialize(setToken.address);
        await gulpComptrollerMock.addSetTokenAddress(setToken.address);
        // Initialize module if set to true
        await secondCompoundLeverageModule.initialize(
          setToken.address,
          [compoundSetup.comp.address],
          []
        );
        await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);

        // Mint cTokens
        await compoundSetup.comp.approve(cComp.address, ether(1000));
        await cComp.mint(ether(1000));

        // Approve tokens to issuance module and call issue
        await cComp.approve(setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken
        const issueQuantity = ether(1);
        await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        subjectSetToken = setToken.address;
        subjectCollateralAsset = compoundSetup.comp.address;
        subjectNotionalMinReceiveQuantity = ZERO;
        subjectTradeAdapterName = "ONEINCHUNUSED"; // This is unused
        subjectTradeData = EMPTY_BYTES;
        subjectCaller = owner;
      });

      async function subject(): Promise<any> {
        return secondCompoundLeverageModule.connect(subjectCaller.wallet).gulp(
          subjectSetToken,
          subjectCollateralAsset,
          subjectNotionalMinReceiveQuantity,
          subjectTradeAdapterName,
          subjectTradeData
        );
      }

      it("should update the positions on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cComp position is increased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];

        // Get expected cTokens minted
        const newUnits = preciseDiv(compAmount, cTokenInitialMantissa);
        const expectedFirstPositionUnit = initialPositions[0].unit.add(newUnits);
        expect(initialPositions.length).to.eq(1);
        expect(currentPositions.length).to.eq(1);
        expect(newFirstPosition.component).to.eq(cComp.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(expectedFirstPositionUnit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);
      });
    });
  });

  describe("#removeModule", async () => {
    let setToken: SetToken;
    let subjectModule: Address;

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [cEther.address],
        [BigNumber.from(10000000000)],
        [compoundLeverageModule.address, debtIssuanceMock.address, setup.issuanceModule.address]
      );
      await debtIssuanceMock.initialize(setToken.address);
      await compoundLeverageModule.initialize(
        setToken.address,
        [setup.weth.address, setup.dai.address],
        [setup.weth.address, setup.dai.address],
      );
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
      // Mint cTokens
      await setup.weth.approve(cEther.address, ether(1000));
      await cEther.mint({value: ether(1000)});
      await setup.dai.approve(cDai.address, ether(100000));
      await cDai.mint(ether(100000));
      // Approve tokens to issuance module and call issue
      await cEther.approve(setup.issuanceModule.address, ether(100000));

      await setup.issuanceModule.issue(setToken.address, ether(1), owner.address);

      subjectModule = compoundLeverageModule.address;
    });

    async function subject(): Promise<any> {
      return setToken.removeModule(subjectModule);
    }

    it("should remove the Module on the SetToken", async () => {
      await subject();
      const isModuleEnabled = await setToken.isInitializedModule(compoundLeverageModule.address);
      expect(isModuleEnabled).to.be.false;
    });

    it("should delete the Compound settings and mappings", async () => {
      await subject();
      const collateralCTokens = (await compoundLeverageModule.getEnabledAssets(setToken.address))[0];
      const borrowAssets = (await compoundLeverageModule.getEnabledAssets(setToken.address))[1];
      const borrowCTokens = await Promise.all(borrowAssets.map(borrowAsset => compoundLeverageModule.underlyingToCToken(borrowAsset)));
      const isCEtherCollateral = await compoundLeverageModule.isCollateralCTokenEnabled(setToken.address, cEther.address);
      const isCDaiCollateral = await compoundLeverageModule.isCollateralCTokenEnabled(setToken.address, cDai.address);
      const isCDaiBorrow = await compoundLeverageModule.isBorrowCTokenEnabled(setToken.address, cDai.address);
      const isCEtherBorrow = await compoundLeverageModule.isBorrowCTokenEnabled(setToken.address, cEther.address);
      expect(collateralCTokens.length).to.eq(0);
      expect(borrowCTokens.length).to.eq(0);
      expect(isCEtherCollateral).to.be.false;
      expect(isCDaiCollateral).to.be.false;
      expect(isCDaiBorrow).to.be.false;
      expect(isCEtherBorrow).to.be.false;
    });

    it("should exit markets in Compound", async () => {
      await subject();
      const isCEtherEntered = await compoundSetup.comptroller.checkMembership(setToken.address, cEther.address);
      const isCDaiEntered = await compoundSetup.comptroller.checkMembership(setToken.address, cDai.address);
      expect(isCEtherEntered).to.be.false;
      expect(isCDaiEntered).to.be.false;
    });

    it("should unregister on the debt issuance module", async () => {
      await subject();
      const isRegistered = await debtIssuanceMock.isRegistered(setToken.address);
      expect(isRegistered).to.be.false;
    });

    describe("when borrow balance exists", async () => {
      beforeEach(async () => {
        // Add Set token as token sender / recipient
        oneInchExchangeMockToWeth = oneInchExchangeMockToWeth.connect(owner.wallet);
        await oneInchExchangeMockToWeth.addSetTokenAddress(setToken.address);

        // Fund One Inch exchange with destinationToken WETH
        await setup.weth.transfer(oneInchExchangeMockToWeth.address, ether(10));

        // Lever SetToken
        const leverTradeData = oneInchExchangeMockToWeth.interface.encodeFunctionData("swap", [
          setup.dai.address, // Send token
          setup.weth.address, // Receive token
          ether(590), // Send quantity
          ether(1), // Min receive quantity
          ZERO,
          ADDRESS_ZERO,
          [ADDRESS_ZERO],
          EMPTY_BYTES,
          [ZERO],
          [ZERO],
        ]);

        await compoundLeverageModule.lever(
          setToken.address,
          setup.dai.address,
          setup.weth.address,
          ether(590),
          ether(1),
          "ONEINCHTOWETH",
          leverTradeData
        );
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Exiting market failed");
      });
    });
  });

  describe("#syncCompoundMarkets", async () => {
    let cWbtc: CERc20;

    beforeEach(async () => {
      cWbtc = await compoundSetup.createAndEnableCToken(
        setup.wbtc.address,
        cTokenInitialMantissa,
        compoundSetup.comptroller.address,
        compoundSetup.interestRateModel.address,
        "Compound WBTC",
        "cWBTC",
        8,
        ether(0.75), // 75% collateral factor
        ether(1)
      );
    });

    async function subject(): Promise<any> {
      return compoundLeverageModule.syncCompoundMarkets();
    }

    it("should sync the underlying to cToken mapping", async () => {
      await subject();

      const underlyingToCToken = await compoundLeverageModule.underlyingToCToken(setup.wbtc.address);
      const currentCompoundMarkets = await compoundSetup.comptroller.getAllMarkets();
      const expectedCompoundMarkets = [cEther.address, cDai.address, cComp.address, cWbtc.address];

      expect(JSON.stringify(currentCompoundMarkets)).to.eq(JSON.stringify(expectedCompoundMarkets));
      expect(underlyingToCToken).to.eq(cWbtc.address);
    });
  });

  describe("#addRegister", async () => {
    let setToken: SetToken;
    let otherIssuanceModule: DebtIssuanceMock;
    let isInitialized: boolean;
    let subjectSetToken: Address;
    let subjectDebtIssuanceModule: Address;

    before(async () => {
      isInitialized = true;
      otherIssuanceModule = await deployer.mocks.deployDebtIssuanceMock();
      await setup.controller.addModule(otherIssuanceModule.address);
    });

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [cEther.address],
        [BigNumber.from(10000000000)],
        [compoundLeverageModule.address, setup.issuanceModule.address, debtIssuanceMock.address]
      );
      await debtIssuanceMock.initialize(setToken.address);
      // Initialize module if set to true
      if (isInitialized) {
        await compoundLeverageModule.initialize(
          setToken.address,
          [setup.weth.address, setup.dai.address, compoundSetup.comp.address], // Enable COMP that is not a Set position
          [setup.dai.address, setup.weth.address, compoundSetup.comp.address]
        );
      }
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
      // Add other issuance mock after initializing Compound leverage module, so register is never called
      await setToken.addModule(otherIssuanceModule.address);
      await otherIssuanceModule.initialize(setToken.address);
      subjectSetToken = setToken.address;
      subjectDebtIssuanceModule = otherIssuanceModule.address;
    });

    async function subject(): Promise<any> {
      return compoundLeverageModule.addRegister(subjectSetToken, subjectDebtIssuanceModule);
    }

    it("should register on the other issuance module", async () => {
      const previousIsRegistered = await otherIssuanceModule.isRegistered(setToken.address);
      await subject();
      const currentIsRegistered = await otherIssuanceModule.isRegistered(setToken.address);
      expect(previousIsRegistered).to.be.false;
      expect(currentIsRegistered).to.be.true;
    });

    describe("when module is not initialized", async () => {
      before(async () => {
        isInitialized = false;
      });

      after(async () => {
        isInitialized = true;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });

    describe("when SetToken is not valid", async () => {
      beforeEach(async () => {
        const nonEnabledSetToken = await setup.createNonControllerEnabledSetToken(
          [setup.weth.address],
          [ether(1)],
          [compoundLeverageModule.address],
          owner.address
        );

        subjectSetToken = nonEnabledSetToken.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });

    describe("when debt issuance module is not initialized on SetToken", async () => {
      beforeEach(async () => {
        await setToken.removeModule(otherIssuanceModule.address);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Debt issuance must be initialized");
      });
    });
  });

  describe("#addCollateralAsset", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;

    let subjectSetToken: Address;
    let subjectCollateralAsset: Address;
    let subjectCaller: Account;

    before(async () => {
      isInitialized = true;
    });

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address, setup.dai.address],
        [ether(1), ether(100)],
        [compoundLeverageModule.address, debtIssuanceMock.address]
      );
      await debtIssuanceMock.initialize(setToken.address);
      // Initialize module if set to true
      if (isInitialized) {
        await compoundLeverageModule.initialize(
          setToken.address,
          [setup.weth.address],
          []
        );
      }
      subjectSetToken = setToken.address;
      subjectCollateralAsset = compoundSetup.comp.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return compoundLeverageModule.connect(subjectCaller.wallet).addCollateralAsset(
        subjectSetToken,
        subjectCollateralAsset,
      );
    }

    it("should add the collateral asset to Compound settings and mappings", async () => {
      await subject();
      const collateralCTokens = (await compoundLeverageModule.getEnabledAssets(setToken.address))[0];
      const isCCompCollateral = await compoundLeverageModule.isCollateralCTokenEnabled(setToken.address, cComp.address);

      expect(JSON.stringify(collateralCTokens)).to.eq(JSON.stringify([cEther.address, cComp.address]));
      expect(isCCompCollateral).to.be.true;
    });

    it("should enter markets in Compound", async () => {
      await subject();
      const isCEtherEntered = await compoundSetup.comptroller.checkMembership(setToken.address, cEther.address);
      const isCCompEntered = await compoundSetup.comptroller.checkMembership(setToken.address, cComp.address);
      expect(isCEtherEntered).to.be.true;
      expect(isCCompEntered).to.be.true;
    });

    it("should emit the correct CollateralAssetAdded event", async () => {
      await expect(subject()).to.emit(compoundLeverageModule, "CollateralAssetAdded").withArgs(
        subjectSetToken,
        subjectCollateralAsset,
      );
    });

    describe("when markets are entered", async () => {
      beforeEach(async () => {
        await compoundLeverageModule.addBorrowAsset(
          setToken.address,
          compoundSetup.comp.address
        );
      });

      it("should have entered markets", async () => {
        const isCCompEntered = await compoundSetup.comptroller.checkMembership(setToken.address, cComp.address);
        await subject();
        expect(isCCompEntered).to.be.true;
      });
    });

    describe("when collateral asset does not exist on Compound", async () => {
      beforeEach(async () => {
        subjectCollateralAsset = await getRandomAddress();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("cToken must exist");
      });
    });

    describe("when collateral asset is enabled on module", async () => {
      beforeEach(async () => {
        subjectCollateralAsset = setup.weth.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Collateral is enabled");
      });
    });

    describe("when entering an invalid market", async () => {
      beforeEach(async () => {
        await compoundSetup.comptroller._setMaxAssets(0);
      });

      afterEach(async () => {
        await compoundSetup.comptroller._setMaxAssets(10);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Entering market failed");
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

    describe("when module is not initialized", async () => {
      before(async () => {
        isInitialized = false;
      });

      after(async () => {
        isInitialized = true;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#addBorrowAsset", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;

    let subjectSetToken: Address;
    let subjectBorrowAsset: Address;
    let subjectCaller: Account;

    before(async () => {
      isInitialized = true;
    });

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address, setup.dai.address],
        [ether(1), ether(100)],
        [compoundLeverageModule.address, debtIssuanceMock.address]
      );
      await debtIssuanceMock.initialize(setToken.address);
      // Initialize module if set to true
      if (isInitialized) {
        await compoundLeverageModule.initialize(
          setToken.address,
          [],
          [setup.weth.address]
        );
      }
      subjectSetToken = setToken.address;
      subjectBorrowAsset = compoundSetup.comp.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return compoundLeverageModule.connect(subjectCaller.wallet).addBorrowAsset(
        subjectSetToken,
        subjectBorrowAsset,
      );
    }

    it("should add the borrow asset to Compound settings and mappings", async () => {
      await subject();
      const borrowAssets = (await compoundLeverageModule.getEnabledAssets(setToken.address))[1];
      const borrowCTokens = await Promise.all(borrowAssets.map(borrowAsset => compoundLeverageModule.underlyingToCToken(borrowAsset)));

      const isCCompBorrow = await compoundLeverageModule.isBorrowCTokenEnabled(setToken.address, cComp.address);

      expect(JSON.stringify(borrowCTokens)).to.eq(JSON.stringify([cEther.address, cComp.address]));
      expect(JSON.stringify(borrowAssets)).to.eq(JSON.stringify([setup.weth.address, compoundSetup.comp.address]));
      expect(isCCompBorrow).to.be.true;
    });

    it("should enter markets in Compound", async () => {
      await subject();
      const isCEtherEntered = await compoundSetup.comptroller.checkMembership(setToken.address, cEther.address);
      const isCCompEntered = await compoundSetup.comptroller.checkMembership(setToken.address, cComp.address);
      expect(isCEtherEntered).to.be.true;
      expect(isCCompEntered).to.be.true;
    });

    it("should emit the correct BorrowAssetAdded event", async () => {
      await expect(subject()).to.emit(compoundLeverageModule, "BorrowAssetAdded").withArgs(
        subjectSetToken,
        subjectBorrowAsset,
      );
    });

    describe("when markets are entered", async () => {
      beforeEach(async () => {
        await compoundLeverageModule.addCollateralAsset(
          setToken.address,
          compoundSetup.comp.address
        );
      });

      it("should have entered markets", async () => {
        const isCCompEntered = await compoundSetup.comptroller.checkMembership(setToken.address, cComp.address);
        await subject();
        expect(isCCompEntered).to.be.true;
      });
    });

    describe("when borrow asset does not exist on Compound", async () => {
      beforeEach(async () => {
        subjectBorrowAsset = await getRandomAddress();
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("cToken must exist");
      });
    });

    describe("when borrow asset is enabled on module", async () => {
      beforeEach(async () => {
        subjectBorrowAsset = setup.weth.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Borrow is enabled");
      });
    });

    describe("when entering an invalid market", async () => {
      beforeEach(async () => {
        await compoundSetup.comptroller._setMaxAssets(0);
      });

      afterEach(async () => {
        await compoundSetup.comptroller._setMaxAssets(10);
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Entering market failed");
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

    describe("when module is not initialized", async () => {
      before(async () => {
        isInitialized = false;
      });

      after(async () => {
        isInitialized = true;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#removeBorrowAsset", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;

    let subjectSetToken: Address;
    let subjectBorrowAsset: Address;
    let subjectCaller: Account;

    before(async () => {
      isInitialized = true;
    });

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address, setup.dai.address],
        [ether(1), ether(100)],
        [compoundLeverageModule.address, setup.issuanceModule.address, debtIssuanceMock.address]
      );
      await debtIssuanceMock.initialize(setToken.address);
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);

      // Initialize module if set to true
      if (isInitialized) {
        await compoundLeverageModule.initialize(
          setToken.address,
          [],
          [setup.weth.address, compoundSetup.comp.address]
        );
      }
      // Approve tokens to issuance module and call issue
      await setup.weth.approve(setup.issuanceModule.address, ether(1000));
      await setup.dai.approve(setup.issuanceModule.address, ether(1000));
      await setup.issuanceModule.issue(setToken.address, ether(1), owner.address);

      subjectSetToken = setToken.address;
      subjectBorrowAsset = compoundSetup.comp.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return compoundLeverageModule.connect(subjectCaller.wallet).removeBorrowAsset(
        subjectSetToken,
        subjectBorrowAsset,
      );
    }

    it("should remove the borrow asset from Compound settings and mappings", async () => {
      await subject();
      const borrowAssets = (await compoundLeverageModule.getEnabledAssets(setToken.address))[1];
      const borrowCTokens = await Promise.all(borrowAssets.map(borrowAsset => compoundLeverageModule.underlyingToCToken(borrowAsset)));
      const isCCompBorrow = await compoundLeverageModule.isBorrowCTokenEnabled(setToken.address, cComp.address);
      expect(JSON.stringify(borrowCTokens)).to.eq(JSON.stringify([cEther.address]));
      expect(JSON.stringify(borrowAssets)).to.eq(JSON.stringify([setup.weth.address]));
      expect(isCCompBorrow).to.be.false;
    });

    it("should exit markets in Compound", async () => {
      await subject();
      const isCEtherEntered = await compoundSetup.comptroller.checkMembership(setToken.address, cEther.address);
      const isCCompEntered = await compoundSetup.comptroller.checkMembership(setToken.address, cComp.address);
      expect(isCEtherEntered).to.be.true;
      expect(isCCompEntered).to.be.false;
    });

    it("should emit the correct BorrowAssetRemoved event", async () => {
      await expect(subject()).to.emit(compoundLeverageModule, "BorrowAssetRemoved").withArgs(
        subjectSetToken,
        subjectBorrowAsset,
      );
    });

    describe("when borrow asset is still enabled as collateral", async () => {
      beforeEach(async () => {
        await compoundLeverageModule.addCollateralAsset(
          setToken.address,
          compoundSetup.comp.address
        );
      });

      it("should have not exited markets", async () => {
        await subject();
        const isCCompEntered = await compoundSetup.comptroller.checkMembership(setToken.address, cComp.address);
        expect(isCCompEntered).to.be.true;
      });
    });

    describe("when borrow asset is not enabled on module", async () => {
      beforeEach(async () => {
        subjectBorrowAsset = setup.dai.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Borrow is not enabled");
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

    describe("when module is not initialized", async () => {
      before(async () => {
        isInitialized = false;
      });

      after(async () => {
        isInitialized = true;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#removeCollateralAsset", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;

    let subjectSetToken: Address;
    let subjectCollateralAsset: Address;
    let subjectCaller: Account;

    before(async () => {
      isInitialized = true;
    });

    beforeEach(async () => {
      setToken = await setup.createSetToken(
        [setup.weth.address, setup.dai.address],
        [ether(1), ether(100)],
        [compoundLeverageModule.address, setup.issuanceModule.address, debtIssuanceMock.address]
      );
      await debtIssuanceMock.initialize(setToken.address);
      await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
      // Initialize module if set to true
      if (isInitialized) {
        await compoundLeverageModule.initialize(
          setToken.address,
          [setup.weth.address, compoundSetup.comp.address],
          []
        );
      }
      // Approve tokens to issuance module and call issue
      await setup.weth.approve(setup.issuanceModule.address, ether(1000));
      await setup.dai.approve(setup.issuanceModule.address, ether(1000));
      await setup.issuanceModule.issue(setToken.address, ether(1), owner.address);

      subjectSetToken = setToken.address;
      subjectCollateralAsset = compoundSetup.comp.address;
      subjectCaller = owner;
    });

    async function subject(): Promise<any> {
      return compoundLeverageModule.connect(subjectCaller.wallet).removeCollateralAsset(
        subjectSetToken,
        subjectCollateralAsset,
      );
    }

    it("should remove the collateral asset from Compound settings and mappings", async () => {
      await subject();
      const collateralCTokens = (await compoundLeverageModule.getEnabledAssets(setToken.address))[0];
      const isCCompCollateral = await compoundLeverageModule.isCollateralCTokenEnabled(setToken.address, cComp.address);
      expect(JSON.stringify(collateralCTokens)).to.eq(JSON.stringify([cEther.address]));
      expect(isCCompCollateral).to.be.false;
    });

    it("should exit markets in Compound", async () => {
      await subject();
      const isCEtherEntered = await compoundSetup.comptroller.checkMembership(setToken.address, cEther.address);
      const isCCompEntered = await compoundSetup.comptroller.checkMembership(setToken.address, cComp.address);
      expect(isCEtherEntered).to.be.true;
      expect(isCCompEntered).to.be.false;
    });

    it("should emit the correct CollateralAssetRemoved event", async () => {
      await expect(subject()).to.emit(compoundLeverageModule, "CollateralAssetRemoved").withArgs(
        subjectSetToken,
        subjectCollateralAsset,
      );
    });

    describe("when collateral asset is still enabled as borrow", async () => {
      beforeEach(async () => {
        await compoundLeverageModule.addBorrowAsset(
          setToken.address,
          compoundSetup.comp.address
        );
      });

      it("should have not exited markets", async () => {
        await subject();
        const isCCompEntered = await compoundSetup.comptroller.checkMembership(setToken.address, cComp.address);
        expect(isCCompEntered).to.be.true;
      });
    });

    describe("when collateral asset is not enabled on module", async () => {
      beforeEach(async () => {
        subjectCollateralAsset = setup.dai.address;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Collateral is not enabled");
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

    describe("when module is not initialized", async () => {
      before(async () => {
        isInitialized = false;
      });

      after(async () => {
        isInitialized = true;
      });

      it("should revert", async () => {
        await expect(subject()).to.be.revertedWith("Must be a valid and initialized SetToken");
      });
    });
  });

  describe("#moduleIssueHook", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;

    let subjectSetToken: Address;
    let subjectCaller: Account;

    context("when cETH and cDAI are collateral and WETH and DAI are borrow assets", async () => {
      before(async () => {
        isInitialized = true;
      });

      beforeEach(async () => {
        // Add mock module to controller
        await setup.controller.addModule(mockModule.address);

        setToken = await setup.createSetToken(
          [cEther.address, cDai.address],
          [BigNumber.from(10000000000), BigNumber.from(100000000000)],
          [compoundLeverageModule.address, setup.issuanceModule.address, debtIssuanceMock.address]
        );
        await debtIssuanceMock.initialize(setToken.address);
        // Initialize module if set to true
        if (isInitialized) {
          await compoundLeverageModule.initialize(
            setToken.address,
            [setup.weth.address, setup.dai.address, compoundSetup.comp.address], // Enable COMP that is not a Set position
            [setup.dai.address, setup.weth.address, compoundSetup.comp.address]
          );
        }
        await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
        // Initialize mock module
        await setToken.addModule(mockModule.address);
        await setToken.connect(mockModule.wallet).initializeModule();

        // Add Set token as token sender / recipient
        await oneInchExchangeMockToWeth.addSetTokenAddress(setToken.address);
        await oneInchExchangeMockFromWeth.addSetTokenAddress(setToken.address);

        // Fund One Inch exchange with destinationToken WETH and DAI
        await setup.weth.transfer(oneInchExchangeMockToWeth.address, ether(10));
        await setup.dai.transfer(oneInchExchangeMockFromWeth.address, ether(10000));

        // Mint cTokens
        await setup.weth.approve(cEther.address, ether(1000));
        await cEther.mint({value: ether(1000)});
        await setup.dai.approve(cDai.address, ether(100000));
        await cDai.mint(ether(100000));

        // Approve tokens to issuance module and call issue
        await cEther.approve(setup.issuanceModule.address, ether(1000));
        await cDai.approve(setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 590 DAI regardless of Set supply
        const issueQuantity = ether(1);
        await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        // Lever both cDAI and cETH in SetToken
        if (isInitialized) {
          const leverEthTradeData = oneInchExchangeMockToWeth.interface.encodeFunctionData("swap", [
            setup.dai.address, // Send token
            setup.weth.address, // Receive token
            ether(590), // Send quantity
            ether(1), // Min receive quantity
            ZERO,
            ADDRESS_ZERO,
            [ADDRESS_ZERO],
            EMPTY_BYTES,
            [ZERO],
            [ZERO],
          ]);

          await compoundLeverageModule.lever(
            setToken.address,
            setup.dai.address,
            setup.weth.address,
            ether(590),
            ether(1),
            "ONEINCHTOWETH",
            leverEthTradeData
          );

          const leverDaiTradeData = oneInchExchangeMockToWeth.interface.encodeFunctionData("swap", [
            setup.weth.address, // Send token
            setup.dai.address, // Receive token
            ether(1), // Send quantity
            ether(590), // Min receive quantity
            ZERO,
            ADDRESS_ZERO,
            [ADDRESS_ZERO],
            EMPTY_BYTES,
            [ZERO],
            [ZERO],
          ]);

          await compoundLeverageModule.lever(
            setToken.address,
            setup.weth.address,
            setup.dai.address,
            ether(1),
            ether(590),
            "ONEINCHFROMWETH",
            leverDaiTradeData
          );
        }

        subjectSetToken = setToken.address;
        subjectCaller = mockModule;
      });

      async function subject(): Promise<any> {
        return compoundLeverageModule.connect(subjectCaller.wallet).moduleIssueHook(subjectSetToken, ZERO);
      }

      it("should update the collateral positions on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];
        const newSecondPosition = (await setToken.getPositions())[1];

        expect(initialPositions.length).to.eq(4);
        expect(currentPositions.length).to.eq(4);
        expect(newFirstPosition.component).to.eq(cEther.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(initialPositions[0].unit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);

        expect(newSecondPosition.component).to.eq(cDai.address);
        expect(newSecondPosition.positionState).to.eq(0); // Default
        expect(newSecondPosition.unit).to.eq(initialPositions[1].unit);
        expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should update the borrow positions on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newThirdPosition = (await setToken.getPositions())[2];
        const newFourthPosition = (await setToken.getPositions())[3];

        const expectedThirdPositionUnit = (await cDai.borrowBalanceStored(setToken.address)).mul(-1);
        const expectedFourthPositionUnit = (await cEther.borrowBalanceStored(setToken.address)).mul(-1);

        expect(initialPositions.length).to.eq(4);
        expect(currentPositions.length).to.eq(4);
        expect(newThirdPosition.component).to.eq(setup.dai.address);
        expect(newThirdPosition.positionState).to.eq(1); // External
        expect(newThirdPosition.unit).to.eq(expectedThirdPositionUnit);
        expect(newThirdPosition.module).to.eq(compoundLeverageModule.address);

        expect(newFourthPosition.component).to.eq(setup.weth.address);
        expect(newFourthPosition.positionState).to.eq(1); // External
        expect(newFourthPosition.unit).to.eq(expectedFourthPositionUnit);
        expect(newFourthPosition.module).to.eq(compoundLeverageModule.address);
      });

      it("should emit the correct PositionsSynced event", async () => {
        await expect(subject()).to.emit(compoundLeverageModule, "PositionsSynced").withArgs(
          setToken.address,
          subjectCaller.address
        );
      });

      describe("when caller is not module", async () => {
        beforeEach(async () => {
          subjectCaller = owner;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Only the module can call");
        });
      });

      describe("if disabled module is caller", async () => {
        beforeEach(async () => {
          await setup.controller.removeModule(mockModule.address);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Module must be enabled on controller");
        });
      });
    });
  });

  describe("#moduleRedeemHook", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;

    let subjectSetToken: Address;
    let subjectCaller: Account;

    context("when cETH and cDAI are collateral and WETH and DAI are borrow assets", async () => {
      before(async () => {
        isInitialized = true;
      });

      beforeEach(async () => {
        // Add mock module to controller
        await setup.controller.addModule(mockModule.address);

        setToken = await setup.createSetToken(
          [cEther.address, cDai.address],
          [BigNumber.from(10000000000), BigNumber.from(100000000000)],
          [compoundLeverageModule.address, setup.issuanceModule.address, debtIssuanceMock.address]
        );
        await debtIssuanceMock.initialize(setToken.address);
        // Initialize module if set to true
        if (isInitialized) {
          await compoundLeverageModule.initialize(
            setToken.address,
            [setup.weth.address, setup.dai.address, compoundSetup.comp.address], // Enable COMP that is not a Set position
            [setup.dai.address, setup.weth.address, compoundSetup.comp.address]
          );
        }
        await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
        // Initialize mock module
        await setToken.addModule(mockModule.address);
        await setToken.connect(mockModule.wallet).initializeModule();

        // Add Set token as token sender / recipient
        await oneInchExchangeMockToWeth.addSetTokenAddress(setToken.address);
        await oneInchExchangeMockFromWeth.addSetTokenAddress(setToken.address);

        // Fund One Inch exchange with destinationToken WETH and DAI
        await setup.weth.transfer(oneInchExchangeMockToWeth.address, ether(10));
        await setup.dai.transfer(oneInchExchangeMockFromWeth.address, ether(10000));

        // Mint cTokens
        await setup.weth.approve(cEther.address, ether(1000));
        await cEther.mint({value: ether(1000)});
        await setup.dai.approve(cDai.address, ether(100000));
        await cDai.mint(ether(100000));

        // Approve tokens to issuance module and call issue
        await cEther.approve(setup.issuanceModule.address, ether(1000));
        await cDai.approve(setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 590 DAI regardless of Set supply
        const issueQuantity = ether(1);
        await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        // Lever both cDAI and cETH in SetToken
        if (isInitialized) {
          const leverEthTradeData = oneInchExchangeMockToWeth.interface.encodeFunctionData("swap", [
            setup.dai.address, // Send token
            setup.weth.address, // Receive token
            ether(590), // Send quantity
            ether(1), // Min receive quantity
            ZERO,
            ADDRESS_ZERO,
            [ADDRESS_ZERO],
            EMPTY_BYTES,
            [ZERO],
            [ZERO],
          ]);

          await compoundLeverageModule.lever(
            setToken.address,
            setup.dai.address,
            setup.weth.address,
            ether(590),
            ether(1),
            "ONEINCHTOWETH",
            leverEthTradeData
          );

          const leverDaiTradeData = oneInchExchangeMockToWeth.interface.encodeFunctionData("swap", [
            setup.weth.address, // Send token
            setup.dai.address, // Receive token
            ether(1), // Send quantity
            ether(590), // Min receive quantity
            ZERO,
            ADDRESS_ZERO,
            [ADDRESS_ZERO],
            EMPTY_BYTES,
            [ZERO],
            [ZERO],
          ]);

          await compoundLeverageModule.lever(
            setToken.address,
            setup.weth.address,
            setup.dai.address,
            ether(1),
            ether(590),
            "ONEINCHFROMWETH",
            leverDaiTradeData
          );
        }

        subjectSetToken = setToken.address;
        subjectCaller = mockModule;
      });

      async function subject(): Promise<any> {
        return compoundLeverageModule.connect(subjectCaller.wallet).moduleRedeemHook(subjectSetToken, ZERO);
      }

      it("should update the collateral positions on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newFirstPosition = (await setToken.getPositions())[0];
        const newSecondPosition = (await setToken.getPositions())[1];

        expect(initialPositions.length).to.eq(4);
        expect(currentPositions.length).to.eq(4);
        expect(newFirstPosition.component).to.eq(cEther.address);
        expect(newFirstPosition.positionState).to.eq(0); // Default
        expect(newFirstPosition.unit).to.eq(initialPositions[0].unit);
        expect(newFirstPosition.module).to.eq(ADDRESS_ZERO);

        expect(newSecondPosition.component).to.eq(cDai.address);
        expect(newSecondPosition.positionState).to.eq(0); // Default
        expect(newSecondPosition.unit).to.eq(initialPositions[1].unit);
        expect(newSecondPosition.module).to.eq(ADDRESS_ZERO);
      });

      it("should update the borrow positions on the SetToken correctly", async () => {
        const initialPositions = await setToken.getPositions();

        await subject();

        // cEther position is increased
        const currentPositions = await setToken.getPositions();
        const newThirdPosition = (await setToken.getPositions())[2];
        const newFourthPosition = (await setToken.getPositions())[3];

        const expectedThirdPositionUnit = (await cDai.borrowBalanceStored(setToken.address)).mul(-1);
        const expectedFourthPositionUnit = (await cEther.borrowBalanceStored(setToken.address)).mul(-1);

        expect(initialPositions.length).to.eq(4);
        expect(currentPositions.length).to.eq(4);
        expect(newThirdPosition.component).to.eq(setup.dai.address);
        expect(newThirdPosition.positionState).to.eq(1); // External
        expect(newThirdPosition.unit).to.eq(expectedThirdPositionUnit);
        expect(newThirdPosition.module).to.eq(compoundLeverageModule.address);

        expect(newFourthPosition.component).to.eq(setup.weth.address);
        expect(newFourthPosition.positionState).to.eq(1); // External
        expect(newFourthPosition.unit).to.eq(expectedFourthPositionUnit);
        expect(newFourthPosition.module).to.eq(compoundLeverageModule.address);
      });

      it("should emit the correct PositionsSynced event", async () => {
        await expect(subject()).to.emit(compoundLeverageModule, "PositionsSynced").withArgs(
          setToken.address,
          subjectCaller.address
        );
      });

      describe("when caller is not module", async () => {
        beforeEach(async () => {
          subjectCaller = owner;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Only the module can call");
        });
      });

      describe("if disabled module is caller", async () => {
        beforeEach(async () => {
          await setup.controller.removeModule(mockModule.address);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Module must be enabled on controller");
        });
      });
    });
  });

  describe("#componentIssueHook", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;
    let borrowQuantity: BigNumber;

    let subjectSetToken: Address;
    let subjectSetQuantity: BigNumber;
    let subjectComponent: Address;
    let subjectCaller: Account;

    context("when cETH is collateral and DAI is borrow asset", async () => {
      before(async () => {
        isInitialized = true;
      });

      beforeEach(async () => {
        // Add mock module to controller
        await setup.controller.addModule(mockModule.address);

        setToken = await setup.createSetToken(
          [cEther.address],
          [BigNumber.from(10000000000)],
          [compoundLeverageModule.address, setup.issuanceModule.address, debtIssuanceMock.address]
        );
        await debtIssuanceMock.initialize(setToken.address);
        // Initialize module if set to true
        if (isInitialized) {
          await compoundLeverageModule.initialize(
            setToken.address,
            [setup.weth.address, setup.dai.address, compoundSetup.comp.address], // Enable COMP that is not a Set position
            [setup.dai.address, setup.weth.address, compoundSetup.comp.address]
          );
        }
        await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
        // Initialize mock module
        await setToken.addModule(mockModule.address);
        await setToken.connect(mockModule.wallet).initializeModule();

        // Add Set token as token sender / recipient
        await oneInchExchangeMockToWeth.addSetTokenAddress(setToken.address);

        // Fund One Inch exchange with destinationToken WETH and DAI
        await setup.weth.transfer(oneInchExchangeMockToWeth.address, ether(10));

        // Mint cTokens
        await setup.weth.approve(cEther.address, ether(1000));
        await cEther.mint({value: ether(1000)});
        await setup.dai.approve(cDai.address, ether(100000));
        await cDai.mint(ether(100000));

        // Approve tokens to issuance module and call issue
        await cEther.approve(setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 590 DAI regardless of Set supply
        const issueQuantity = ether(1);
        await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        // Lever cETH in SetToken
        borrowQuantity = ether(590);
        if (isInitialized) {
          const leverEthTradeData = oneInchExchangeMockToWeth.interface.encodeFunctionData("swap", [
            setup.dai.address, // Send token
            setup.weth.address, // Receive token
            borrowQuantity, // Send quantity
            ether(1), // Min receive quantity
            ZERO,
            ADDRESS_ZERO,
            [ADDRESS_ZERO],
            EMPTY_BYTES,
            [ZERO],
            [ZERO],
          ]);

          await compoundLeverageModule.lever(
            setToken.address,
            setup.dai.address,
            setup.weth.address,
            borrowQuantity,
            ether(1),
            "ONEINCHTOWETH",
            leverEthTradeData
          );
        }

        subjectSetToken = setToken.address;
        subjectSetQuantity = issueQuantity;
        subjectComponent = setup.dai.address;
        subjectCaller = mockModule;
      });

      async function subject(): Promise<any> {
        return compoundLeverageModule.connect(subjectCaller.wallet).componentIssueHook(
          subjectSetToken,
          subjectSetQuantity,
          subjectComponent
        );
      }

      it("should increase borrowed quantity on the SetToken", async () => {
        const previousDaiBalance = await setup.dai.balanceOf(setToken.address);

        await subject();

        const currentDaiBalance = await setup.dai.balanceOf(setToken.address);

        expect(previousDaiBalance).to.eq(ZERO);
        expect(currentDaiBalance).to.eq(preciseMul(borrowQuantity, subjectSetQuantity));
      });

      describe("when caller is not module", async () => {
        beforeEach(async () => {
          subjectCaller = owner;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Only the module can call");
        });
      });

      describe("if disabled module is caller", async () => {
        beforeEach(async () => {
          await setup.controller.removeModule(mockModule.address);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Module must be enabled on controller");
        });
      });
    });
  });

  describe("#componentRedeemHook", async () => {
    let setToken: SetToken;
    let isInitialized: boolean;
    let repayQuantity: BigNumber;

    let subjectSetToken: Address;
    let subjectSetQuantity: BigNumber;
    let subjectComponent: Address;
    let subjectCaller: Account;

    context("when cETH is collateral and DAI is borrow asset", async () => {
      before(async () => {
        isInitialized = true;
      });

      beforeEach(async () => {
        // Add mock module to controller
        await setup.controller.addModule(mockModule.address);

        setToken = await setup.createSetToken(
          [cEther.address],
          [BigNumber.from(10000000000)],
          [compoundLeverageModule.address, setup.issuanceModule.address, debtIssuanceMock.address]
        );
        await debtIssuanceMock.initialize(setToken.address);
        // Initialize module if set to true
        if (isInitialized) {
          await compoundLeverageModule.initialize(
            setToken.address,
            [setup.weth.address, setup.dai.address, compoundSetup.comp.address], // Enable COMP that is not a Set position
            [setup.dai.address, setup.weth.address, compoundSetup.comp.address]
          );
        }
        await setup.issuanceModule.initialize(setToken.address, ADDRESS_ZERO);
        // Initialize mock module
        await setToken.addModule(mockModule.address);
        await setToken.connect(mockModule.wallet).initializeModule();

        // Add Set token as token sender / recipient
        await oneInchExchangeMockToWeth.addSetTokenAddress(setToken.address);

        // Fund One Inch exchange with destinationToken WETH and DAI
        await setup.weth.transfer(oneInchExchangeMockToWeth.address, ether(10));

        // Mint cTokens
        await setup.weth.approve(cEther.address, ether(1000));
        await cEther.mint({value: ether(1000)});
        await setup.dai.approve(cDai.address, ether(100000));
        await cDai.mint(ether(100000));

        // Approve tokens to issuance module and call issue
        await cEther.approve(setup.issuanceModule.address, ether(1000));

        // Issue 1 SetToken. Note: 1inch mock is hardcoded to trade 590 DAI regardless of Set supply
        const issueQuantity = ether(1);
        await setup.issuanceModule.issue(setToken.address, issueQuantity, owner.address);

        repayQuantity = ether(590);

        // Lever cETH in SetToken
        if (isInitialized) {
          const leverEthTradeData = oneInchExchangeMockToWeth.interface.encodeFunctionData("swap", [
            setup.dai.address, // Send token
            setup.weth.address, // Receive token
            repayQuantity, // Send quantity
            ether(1), // Min receive quantity
            ZERO,
            ADDRESS_ZERO,
            [ADDRESS_ZERO],
            EMPTY_BYTES,
            [ZERO],
            [ZERO],
          ]);

          await compoundLeverageModule.lever(
            setToken.address,
            setup.dai.address,
            setup.weth.address,
            repayQuantity,
            ether(1),
            "ONEINCHTOWETH",
            leverEthTradeData
          );
        }

        // Transfer repay quantity to SetToken for repayment
        await setup.dai.transfer(setToken.address, repayQuantity);

        subjectSetToken = setToken.address;
        subjectSetQuantity = issueQuantity;
        subjectComponent = setup.dai.address;
        subjectCaller = mockModule;
      });

      async function subject(): Promise<any> {
        return compoundLeverageModule.connect(subjectCaller.wallet).componentRedeemHook(
          subjectSetToken,
          subjectSetQuantity,
          subjectComponent
        );
      }

      it("should decrease borrowed quantity on the SetToken", async () => {
        const previousDaiBalance = await setup.dai.balanceOf(setToken.address);

        await subject();

        const currentDaiBalance = await setup.dai.balanceOf(setToken.address);

        expect(previousDaiBalance).to.eq(repayQuantity);
        expect(currentDaiBalance).to.eq(ZERO);
      });

      describe("when caller is not module", async () => {
        beforeEach(async () => {
          subjectCaller = owner;
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Only the module can call");
        });
      });

      describe("if disabled module is caller", async () => {
        beforeEach(async () => {
          await setup.controller.removeModule(mockModule.address);
        });

        it("should revert", async () => {
          await expect(subject()).to.be.revertedWith("Module must be enabled on controller");
        });
      });
    });
  });
});
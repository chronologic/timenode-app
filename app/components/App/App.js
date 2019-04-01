import React, { Component } from 'react';
import PropTypes from 'prop-types';
import Header from '../Header/Header';
import { CustomProviderModal, ReleaseNotesModal } from '../Modals';
import { Route, Switch, withRouter } from 'react-router-dom';
import TimeNodeRoute from '../TimeNode/TimeNodeRoute';
import URLNotFound from '../Common/URLNotFound';
import { inject } from 'mobx-react';
import { isRunningInElectron } from '../../lib/electron-util';
import NetworkChooserModal from '../Header/NetworkChooserModal';

@withRouter
@inject('web3Service')
@inject('storageService')
class App extends Component {
  constructor(props) {
    super(props);
    this.state = {
      showSearchOverlay: false
    };
    this.updateSearchState = this.updateSearchState.bind(this);
    this.onEscKey = this.onEscKey.bind(this);
    this.getCurrentBlock = this.getCurrentBlock.bind(this);
  }

  /*
    A function that enables or disables the overlay
    of the Search function.
  */
  updateSearchState(enabled) {
    this.setState({ showSearchOverlay: enabled });
  }

  /*
    Esc keypress listener. Used for:
    - Detecting when to close the search overlay
  */
  onEscKey(event) {
    if (event.keyCode === 27 && this.state.showSearchOverlay) {
      this.updateSearchState(false);
    }
  }

  async componentDidMount() {
    const $ = window.jQuery;
    document.addEventListener('keydown', this.onEscKey, false);

    await this.getCurrentBlock();
    // Check every 10 seconds if the block number changed
    this.interval = setInterval(await this.getCurrentBlock, 10000);

    if (isRunningInElectron() && !this.props.storageService.load('changelogSeen')) {
      $('#releaseNotesModal').modal({
        show: true
      });
    }
  }

  async getCurrentBlock() {
    const { web3Service } = this.props;
    await web3Service.fetchBlockNumber();
  }

  componentWillUnmount() {
    clearInterval(this.interval);
  }

  render() {
    return (
      <div className="app-container">
        {/* Hacky way to disable padding in the Pages template */}
        <div className="page-container" style={{ padding: '0px' }}>
          <Header updateSearchState={this.updateSearchState} history={this.props.history} />
          <div className="page-content-wrapper">
            <div className="content sm-gutter">
              <Switch>
                <Route path="/timenode" component={TimeNodeRoute} />
                <Route component={URLNotFound} />
              </Switch>
            </div>
          </div>
        </div>
        <CustomProviderModal />
        <ReleaseNotesModal />
        <NetworkChooserModal />
      </div>
    );
  }
}

App.propTypes = {
  web3Service: PropTypes.any,
  storageService: PropTypes.any,
  history: PropTypes.object.isRequired
};

export default App;

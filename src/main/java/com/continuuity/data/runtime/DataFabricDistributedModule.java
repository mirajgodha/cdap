package com.continuuity.data.runtime;

import org.apache.hadoop.conf.Configuration;
import org.apache.hadoop.hbase.HBaseConfiguration;

import com.continuuity.common.conf.CConfiguration;
import com.continuuity.data.engine.hbase.HBaseNativeOVCTableHandle;
import com.continuuity.data.engine.hbase.HBaseOVCTableHandle;
import com.continuuity.data.engine.memory.oracle.MemoryStrictlyMonotonicTimeOracle;
import com.continuuity.data.operation.executor.OperationExecutor;
import com.continuuity.data.operation.executor.omid.OmidTransactionalOperationExecutor;
import com.continuuity.data.operation.executor.omid.TimestampOracle;
import com.continuuity.data.operation.executor.omid.TransactionOracle;
import com.continuuity.data.operation.executor.omid.memory.MemoryOracle;
import com.continuuity.data.operation.executor.remote.RemoteOperationExecutor;
import com.continuuity.data.table.OVCTableHandle;
import com.google.inject.AbstractModule;
import com.google.inject.Singleton;
import com.google.inject.name.Names;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public class DataFabricDistributedModule extends AbstractModule {

  private static final Logger Log =
      LoggerFactory.getLogger(DataFabricDistributedModule.class);

  private final CConfiguration conf;

  private final Configuration hbaseConf;

  public static final String CONF_ENABLE_NATIVE_QUEUES =
      "fabric.queue.hbase.native";
  
  private static final boolean CONF_ENABLE_NATIVE_QUEUES_DEFAULT = false;

  /**
   * Create a module with default configuration for HBase and Continuuity
   */
  public DataFabricDistributedModule() {
    this.conf = loadConfiguration();
    this.hbaseConf = HBaseConfiguration.create(conf);
  }

  /**
   * Create a module with custom configuration for HBase,
   * and defaults for Continuuity
   */
  public DataFabricDistributedModule(Configuration conf) {
    this.hbaseConf = new Configuration(conf);
    this.conf = loadConfiguration();
  }

  /**
   * Create a module with separate, custom configurations for HBase
   * and for Continuuity
   */
  public DataFabricDistributedModule(Configuration conf,
                                     CConfiguration cconf) {
    this.hbaseConf = new Configuration(conf);
    this.conf = cconf;
  }

  /**
   * Create a module with custom configuration, which will
   * be used both for HBase and for Continuuity
   */
  public DataFabricDistributedModule(CConfiguration conf) {
    this.hbaseConf = new Configuration(conf);
    this.conf = conf;
  }

  private CConfiguration loadConfiguration() {
    CConfiguration conf = CConfiguration.create();

    // this expects the port and number of threads for the opex service
    // - data.opex.server.port <int>
    // - data.opex.server.threads <int>
    // this expects the zookeeper quorum for continuuity and for hbase
    // - zookeeper.quorum host:port,...
    // - hbase.zookeeper.quorum host:port,...
    return conf;
  }

  @Override
  public void configure() {

    Class<? extends OVCTableHandle> ovcTableHandle = HBaseOVCTableHandle.class;
    // Check if native hbase queue handle should be used
    if (conf.getBoolean(CONF_ENABLE_NATIVE_QUEUES,
        CONF_ENABLE_NATIVE_QUEUES_DEFAULT)) {
      ovcTableHandle = HBaseNativeOVCTableHandle.class;
    }
    Log.info("Table Handle is " + ovcTableHandle.getName());

    // Bind our implementations

    // Bind remote operation executor
    bind(OperationExecutor.class)
        .to(RemoteOperationExecutor.class)
        .in(Singleton.class);

    // For data fabric, bind to Omid and HBase
    bind(OperationExecutor.class)
        .annotatedWith(Names.named("DataFabricOperationExecutor"))
        .to(OmidTransactionalOperationExecutor.class)
        .in(Singleton.class);
    bind(OVCTableHandle.class).to(ovcTableHandle);

    // For now, just bind to in-memory omid oracles
    bind(TimestampOracle.class).
        to(MemoryStrictlyMonotonicTimeOracle.class).in(Singleton.class);
    bind(TransactionOracle.class).to(MemoryOracle.class);

    // Bind HBase configuration into ovctable
    bind(Configuration.class)
        .annotatedWith(Names.named("HBaseOVCTableHandleConfig"))
        .toInstance(hbaseConf);

    // Bind our configurations
    bind(CConfiguration.class)
        .annotatedWith(Names.named("RemoteOperationExecutorConfig"))
        .toInstance(conf);
  }

  public CConfiguration getConfiguration() {
    return this.conf;
  }

}
